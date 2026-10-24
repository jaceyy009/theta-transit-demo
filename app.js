import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs,
  orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const passTypes = [
  { id: "single", name: "Single Ride", description: "One accepted scan. The same pass is blocked for 15 minutes after use.", price: 2.50, duration: "One ride", icon: "↗" },
  { id: "bus_day", name: "Bus Day Pass", description: "Demo bus pass valid for one day, subject to 15-minute anti-passback.", price: 5.00, duration: "1 day", icon: "▰" },
  { id: "metro_day", name: "Metro Day Pass", description: "Demo metro pass valid for one day, subject to 15-minute anti-passback.", price: 8.00, duration: "1 day", icon: "▤" },
  { id: "all_day", name: "All-Transit Day Pass", description: "A demo pass for bus and metro, valid for one day.", price: 12.00, duration: "1 day", icon: "⇄" },
  { id: "week", name: "7-Day Pass", description: "A week-long demo pass for all included transit modes.", price: 25.00, duration: "7 days", icon: "▦" },
  { id: "monthly", name: "30-Day Pass", description: "A longer demo pass for repeated testing.", price: 45.00, duration: "30 days", icon: "✦" }
];

let app, auth, db, functions;
let currentUser = null;
let authMode = "login";
let ownedPasses = [];
let transactions = [];
let activeScanner = null;
let toastTimer = null;
const PLACEHOLDER = firebaseConfig.apiKey === "YOUR_API_KEY";

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}
function setMessage(id, message, isError = true) {
  const el = $(id); el.textContent = message;
  el.style.color = isError ? "var(--red)" : "var(--green)";
}
function dollars(n) { return `$${Number(n || 0).toFixed(2)}`; }
function easternDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function easternDateLabel() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
}
function untilMidnightET() {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York",year:"numeric",month:"numeric",day:"numeric"}).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  // Find the next midnight in ET by checking minute-by-minute. This respects DST.
  const now = Date.now();
  for (let ms = 60_000; ms <= 27*60*60*1000; ms += 60_000) {
    if (easternDateKey(new Date(now + ms)) !== `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`) return ms;
  }
  return 0;
}
function updateResetClock() {
  const ms = untilMidnightET();
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  $("reset-countdown").textContent = `${h}h ${m}m`;
  $("eastern-date").textContent = easternDateLabel();
}
function showAuth() {
  $("auth-panel").classList.remove("hidden"); $("app-panel").classList.add("hidden");
  $("logout-button").classList.add("hidden");
}
function showApp() {
  $("auth-panel").classList.add("hidden"); $("app-panel").classList.remove("hidden");
  $("logout-button").classList.remove("hidden");
}
function renderCatalog() {
  $("pass-catalog").innerHTML = passTypes.map(p => `
    <article class="pass-card">
      <div class="pass-icon">${p.icon}</div><h3>${p.name}</h3>
      <p>${p.description}</p>
      <div class="pass-bottom"><div class="price">${dollars(p.price)}<small> / pass</small></div>
      <button class="button button-primary" data-buy="${p.id}">Buy pass</button></div>
    </article>`).join("");
  $("pass-catalog").querySelectorAll("[data-buy]").forEach(b => b.addEventListener("click", () => buyPass(b.dataset.buy)));
}
function renderOwnedPasses() {
  $("pass-count").textContent = `${ownedPasses.length} ${ownedPasses.length === 1 ? "pass" : "passes"}`;
  if (!ownedPasses.length) {
    $("my-passes").innerHTML = `<div class="empty-state">No passes yet. Buy your first demo pass above.</div>`; return;
  }
  $("my-passes").innerHTML = ownedPasses.map(p => {
    const type = passTypes.find(x => x.id === p.type) || {name:"Transit Pass", icon:"▦"};
    const used = p.lastUsedAt?.toDate ? p.lastUsedAt.toDate() : (p.lastUsedAt ? new Date(p.lastUsedAt) : null);
    const cooldown = used && Date.now() - used.getTime() < 15*60*1000;
    const status = p.status === "used" ? "Used" : cooldown ? "15-minute cooldown active" : "Ready to scan";
    return `<div class="owned-pass"><div class="pass-icon">${type.icon}</div><div class="owned-main"><strong>${type.name}</strong><span>${status} · ID ${String(p.id).slice(0,12)}</span></div><div class="owned-actions"><button class="button button-outline" data-ticket="${p.id}">Show QR</button></div></div>`;
  }).join("");
  $("my-passes").querySelectorAll("[data-ticket]").forEach(b => b.addEventListener("click", () => showTicket(b.dataset.ticket)));
}
function renderTransactions() {
  if (!transactions.length) { $("transactions").innerHTML = `<div class="empty-state">Your purchases and validations will appear here.</div>`; return; }
  $("transactions").innerHTML = transactions.map(t => {
    const date = t.createdAt?.toDate ? t.createdAt.toDate() : (t.createdAt ? new Date(t.createdAt) : null);
    const when = date ? date.toLocaleString() : "Recent";
    const amount = Number(t.amount || 0);
    return `<div class="transaction"><div class="tx-icon">${t.type === "purchase" ? "↘" : "✓"}</div><div class="tx-main"><strong>${t.description || (t.type === "purchase" ? "Pass purchase" : "Transit activity")}</strong><span>${when}</span></div><div class="tx-amount">${t.type === "purchase" ? "−" : ""}${dollars(amount)}</div></div>`;
  }).join("");
}
function updateBalance(balance) { $("balance").textContent = dollars(balance); }
async function loadDashboard() {
  if (!currentUser) return;
  // The wallet is initialized/reset on the trusted backend; do not write balance from the browser.
  try {
    const ensureWallet = httpsCallable(functions, "ensureDailyWallet");
    const result = await ensureWallet({});
    updateBalance(result.data.balance);
  } catch (e) {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists()) updateBalance(snap.data().balance ?? 50);
    else updateBalance(50);
    console.warn("Wallet callable unavailable; showing read-only fallback.", e);
  }
  const passSnap = await getDocs(query(collection(db, "passes"), where("ownerUid", "==", currentUser.uid), orderBy("createdAt", "desc")));
  ownedPasses = passSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderOwnedPasses();
  try {
    const txSnap = await getDocs(query(collection(db, "transactions"), where("uid", "==", currentUser.uid), orderBy("createdAt", "desc"), limit(10)));
    transactions = txSnap.docs.map(d => ({id:d.id,...d.data()}));
  } catch (e) { transactions = []; console.warn("Could not load transactions", e); }
  renderTransactions(); updateResetClock();
}
async function buyPass(typeId) {
  const p = passTypes.find(x => x.id === typeId);
  if (!p || !currentUser) return;
  const button = document.querySelector(`[data-buy="${typeId}"]`);
  if (button) button.disabled = true;
  try {
    const purchase = httpsCallable(functions, "purchasePass");
    const result = await purchase({ type: typeId });
    toast(`${p.name} purchased for ${dollars(p.price)}.`);
    updateBalance(result.data.balance);
    await loadDashboard();
  } catch (e) {
    console.error(e);
    toast(friendlyError(e, "Purchase unavailable. Deploy the Firebase Functions included in this project."));
  } finally { if (button) button.disabled = false; }
}
function showTicket(passId) {
  const pass = ownedPasses.find(p => p.id === passId);
  if (!pass) return;
  const type = passTypes.find(x => x.id === pass.type) || {name:"Transit Pass",duration:""};
  $("ticket-name").textContent = type.name;
  $("ticket-description").textContent = `${type.duration} · Demo ticket`;
  $("ticket-code").textContent = pass.id;
  $("ticket-status").textContent = pass.status === "used" ? "Already used" : "Active demo pass";
  $("ticket-qr").innerHTML = "";
  if (window.QRCode) new QRCode($("ticket-qr"), { text: JSON.stringify({passId:pass.id}), width:200, height:200, correctLevel:QRCode.CorrectLevel.M });
  else $("ticket-qr").textContent = "QR library failed to load.";
  $("ticket-dialog").showModal();
}
function showValidation(ok, title, detail, cooldownMs = 0) {
  $("validation-icon").textContent = ok ? "✓" : "×";
  $("validation-icon").className = `result-symbol ${ok ? "success" : "error"}`;
  $("validation-title").textContent = title;
  $("validation-detail").textContent = detail;
  $("cooldown-line").classList.toggle("hidden", !cooldownMs);
  if (cooldownMs) $("cooldown-line").textContent = `Try again in ${Math.ceil(cooldownMs/60000)} minute(s).`;
}
async function validatePayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { showValidation(false,"Invalid QR payload","This code is not a valid Theta Transit pass payload."); return; }
  if (!payload.passId || typeof payload.passId !== "string") { showValidation(false,"Pass ID missing","The QR code does not contain a pass ID."); return; }
  try {
    const validate = httpsCallable(functions, "validatePass");
    const result = await validate({ passId: payload.passId });
    if (result.data.accepted) {
      showValidation(true,"PASS ACCEPTED",result.data.message || "Valid demo pass. Anti-passback timer started.");
      toast("Pass accepted.");
    } else {
      showValidation(false,"PASS REJECTED",result.data.message || "This pass cannot be accepted.");
    }
    await loadDashboard();
  } catch (e) {
    console.error(e);
    showValidation(false,"Validation unavailable",friendlyError(e,"Deploy the Firebase Functions to enable secure validation."));
  }
}
function friendlyError(e, fallback) {
  const code = e?.code || "";
  if (code.includes("auth/email-already-in-use")) return "An account already exists for this email.";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Email or password is incorrect.";
  if (code.includes("auth/weak-password")) return "Use a password with at least 6 characters.";
  if (code.includes("functions/failed-precondition")) return e.message || "This action cannot be completed.";
  if (code.includes("functions/resource-exhausted")) return e.message || "Not enough daily credits.";
  if (code.includes("functions/not-found")) return "That pass was not found.";
  if (code.includes("functions/permission-denied")) return "You are not allowed to use this pass.";
  return e?.message || fallback;
}
async function submitAuth(event) {
  event.preventDefault();
  if (PLACEHOLDER) { setMessage("auth-message","First add your Firebase web app configuration to firebase-config.js."); return; }
  const email = $("email").value.trim(), password = $("password").value;
  $("auth-submit").disabled = true;
  try {
    if (authMode === "signup") await createUserWithEmailAndPassword(auth,email,password);
    else await signInWithEmailAndPassword(auth,email,password);
    $("auth-form").reset(); setMessage("auth-message","");
  } catch(e) { setMessage("auth-message",friendlyError(e,"Could not sign in.")); }
  finally { $("auth-submit").disabled = false; }
}
function initFirebase() {
  if (PLACEHOLDER) {
    $("auth-status").textContent = "Firebase setup required";
    setMessage("auth-message","Add your Firebase config to firebase-config.js to enable accounts.");
    return;
  }
  app = initializeApp(firebaseConfig); auth = getAuth(app); db = getFirestore(app); functions = getFunctions(app, "us-central1");
  onAuthStateChanged(auth, async user => {
    currentUser = user;
    if (!user) { $("auth-status").textContent = "Not signed in"; showAuth(); return; }
    $("auth-status").textContent = user.email || "Signed in";
    showApp();
    try { await loadDashboard(); } catch(e) { console.error(e); toast("Some dashboard data could not be loaded."); }
  });
}
document.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => {
  authMode = button.dataset.authMode;
  document.querySelectorAll("[data-auth-mode]").forEach(b=>b.classList.toggle("active",b===button));
  $("auth-submit").textContent = authMode === "signup" ? "Create account" : "Sign in";
  $("password").autocomplete = authMode === "signup" ? "new-password" : "current-password";
  setMessage("auth-message","");
}));
$("auth-form").addEventListener("submit", submitAuth);
$("logout-button").addEventListener("click", async () => { if(auth) await signOut(auth); });
$("scroll-passes").addEventListener("click", () => $("passes-section").scrollIntoView({behavior:"smooth"}));
$("close-ticket").addEventListener("click", () => $("ticket-dialog").close());
$("manual-validate").addEventListener("click", () => validatePayload($("manual-qr").value.trim()));
$("start-scan").addEventListener("click", async () => {
  if (!window.Html5Qrcode) { toast("Camera scanner library failed to load."); return; }
  if (activeScanner) return;
  activeScanner = new Html5Qrcode("qr-reader");
  try {
    $("start-scan").disabled = true; $("stop-scan").disabled = false;
    await activeScanner.start({facingMode:"environment"},{fps:10,qrbox:{width:230,height:230}}, async decoded => {
      await stopScanner(); $("manual-qr").value = decoded; await validatePayload(decoded);
    }, () => {});
  } catch(e) {
    console.error(e); await stopScanner(); toast("Camera access failed. Use HTTPS, allow camera permission, or paste a QR payload.");
  }
});
async function stopScanner() {
  if (activeScanner) {
    try { if (activeScanner.isScanning) await activeScanner.stop(); await activeScanner.clear(); } catch(e) {}
    activeScanner = null;
  }
  $("start-scan").disabled = false; $("stop-scan").disabled = true;
}
$("stop-scan").addEventListener("click", stopScanner);
renderCatalog(); initFirebase();
updateResetClock(); setInterval(updateResetClock,30000);
