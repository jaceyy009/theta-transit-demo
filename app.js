
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);

const passTypes = [
  { id: "single", name: "Single Ride", description: "One accepted scan. Cannot be reused.", price: 2.50, duration: "One ride", icon: "↗", singleUse: true },
  { id: "bus_day", name: "Bus Day Pass", description: "A demo bus pass with a 15-minute scan cooldown.", price: 5, duration: "1 day", days: 1, icon: "▰" },
  { id: "metro_day", name: "Metro Day Pass", description: "A demo metro pass with a 15-minute scan cooldown.", price: 8, duration: "1 day", days: 1, icon: "▤" },
  { id: "all_day", name: "All-Transit Day Pass", description: "A demo bus and metro pass.", price: 12, duration: "1 day", days: 1, icon: "⇄" },
  { id: "week", name: "7-Day Pass", description: "A week-long demo pass.", price: 25, duration: "7 days", days: 7, icon: "▦" },
  { id: "monthly", name: "30-Day Pass", description: "A 30-day demo pass.", price: 45, duration: "30 days", days: 30, icon: "✦" }
];

let app, auth;
let currentUser = null;
let authMode = "login";
let ownedPasses = [];
let transactions = [];
let activeScanner = null;
let toastTimer = null;

const PLACEHOLDER =
  !firebaseConfig.apiKey ||
  firebaseConfig.apiKey === "YOUR_API_KEY";

const COOLDOWN_MS = 15 * 60 * 1000;
const STARTING_BALANCE = 50;

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("toast").classList.remove("show"),
    3200
  );
}

function setMessage(id, message, isError = true) {
  const el = $(id);
  el.textContent = message;
  el.style.color = isError ? "var(--red)" : "var(--green)";
}

function dollars(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function easternDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function easternDateLabel() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(new Date());
}

function storageKey() {
  return `thetaTransitDemo_${currentUser.uid}`;
}

function saveDemoState(state) {
  localStorage.setItem(storageKey(), JSON.stringify(state));
}

function loadDemoState() {
  const today = easternDateKey();
  let state;

  try {
    state = JSON.parse(localStorage.getItem(storageKey()) || "null");
  } catch {
    state = null;
  }

  if (!state || typeof state !== "object") {
    state = {
      dateKey: today,
      balance: STARTING_BALANCE,
      passes: [],
      transactions: []
    };
  }

  if (!Array.isArray(state.passes)) state.passes = [];
  if (!Array.isArray(state.transactions)) state.transactions = [];

  // Reset the demo wallet on the next visit/action after midnight ET.
  if (state.dateKey !== today) {
    state.dateKey = today;
    state.balance = STARTING_BALANCE;
    state.transactions.unshift({
      id: makeId(),
      type: "reset",
      description: "Daily demo wallet reset",
      amount: 0,
      createdAt: new Date().toISOString()
    });
  }

  // This is demo behavior, not a secure balance enforcement mechanism.
  state.balance = Math.max(0, Math.min(
    STARTING_BALANCE,
    Number(state.balance) || 0
  ));

  saveDemoState(state);
  return state;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addTransaction(state, type, description, amount = 0) {
  state.transactions.unshift({
    id: makeId(),
    type,
    description,
    amount,
    createdAt: new Date().toISOString()
  });

  state.transactions = state.transactions.slice(0, 100);
}

function untilMidnightET() {
  const now = Date.now();
  const today = easternDateKey();

  // Find the next Eastern midnight. The timezone formatter handles DST.
  for (let ms = 60000; ms <= 27 * 60 * 60 * 1000; ms += 60000) {
    if (easternDateKey(new Date(now + ms)) !== today) {
      return ms;
    }
  }

  return 0;
}

function updateResetClock() {
  const ms = untilMidnightET();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);

  $("reset-countdown").textContent = `${hours}h ${minutes}m`;
  $("eastern-date").textContent = easternDateLabel();
}

function showAuth() {
  $("auth-panel").classList.remove("hidden");
  $("app-panel").classList.add("hidden");
  $("logout-button").classList.add("hidden");
}

function showApp() {
  $("auth-panel").classList.add("hidden");
  $("app-panel").classList.remove("hidden");
  $("logout-button").classList.remove("hidden");
}

function updateBalance(balance) {
  $("balance").textContent = dollars(balance);
}

function renderCatalog() {
  $("pass-catalog").innerHTML = passTypes.map(p => `
    <article class="pass-card">
      <div class="pass-icon">${escapeHTML(p.icon)}</div>
      <h3>${escapeHTML(p.name)}</h3>
      <p>${escapeHTML(p.description)}</p>
      <div class="pass-bottom">
        <div class="price">${dollars(p.price)}<small> / pass</small></div>
        <button class="button button-primary" data-buy="${p.id}">Buy pass</button>
      </div>
    </article>
  `).join("");

  $("pass-catalog").querySelectorAll("[data-buy]").forEach(button => {
    button.addEventListener("click", () => buyPass(button.dataset.buy));
  });
}

function getPassStatus(pass) {
  if (pass.type === "single" && pass.lastUsedAt) {
    return "Used";
  }

  if (pass.expiresAt && Date.now() >= new Date(pass.expiresAt).getTime()) {
    return "Expired";
  }

  if (pass.lastUsedAt) {
    const remaining = COOLDOWN_MS -
      (Date.now() - new Date(pass.lastUsedAt).getTime());

    if (remaining > 0) return "15-minute cooldown active";
  }

  return "Ready to scan";
}

function renderOwnedPasses() {
  $("pass-count").textContent =
    `${ownedPasses.length} ${ownedPasses.length === 1 ? "pass" : "passes"}`;

  if (!ownedPasses.length) {
    $("my-passes").innerHTML =
      `<div class="empty-state">No passes yet. Buy your first demo pass above.</div>`;
    return;
  }

  $("my-passes").innerHTML = ownedPasses.map(pass => {
    const type = passTypes.find(item => item.id === pass.type) ||
      { name: "Transit Pass", icon: "▦" };

    return `
      <div class="owned-pass">
        <div class="pass-icon">${escapeHTML(type.icon)}</div>
        <div class="owned-main">
          <strong>${escapeHTML(type.name)}</strong>
          <span>${escapeHTML(getPassStatus(pass))} · ID ${escapeHTML(pass.id.slice(0, 12))}</span>
        </div>
        <div class="owned-actions">
          <button class="button button-outline" data-ticket="${escapeHTML(pass.id)}">Show QR</button>
        </div>
      </div>
    `;
  }).join("");

  $("my-passes").querySelectorAll("[data-ticket]").forEach(button => {
    button.addEventListener("click", () => showTicket(button.dataset.ticket));
  });
}

function renderTransactions() {
  if (!transactions.length) {
    $("transactions").innerHTML =
      `<div class="empty-state">Your purchases and validations will appear here.</div>`;
    return;
  }

  $("transactions").innerHTML = transactions.slice(0, 10).map(tx => {
    const date = tx.createdAt ? new Date(tx.createdAt) : null;
    const when = date && !Number.isNaN(date.getTime())
      ? date.toLocaleString()
      : "Recent";

    const symbol = tx.type === "purchase" ? "↘" :
      tx.type === "validation" ? "✓" : "↻";

    const amount = tx.type === "purchase"
      ? `−${dollars(tx.amount)}`
      : dollars(tx.amount);

    return `
      <div class="transaction">
        <div class="tx-icon">${symbol}</div>
        <div class="tx-main">
          <strong>${escapeHTML(tx.description)}</strong>
          <span>${escapeHTML(when)}</span>
        </div>
        <div class="tx-amount">${amount}</div>
      </div>
    `;
  }).join("");
}

async function loadDashboard() {
  if (!currentUser) return;

  const state = loadDemoState();
  ownedPasses = state.passes;
  transactions = state.transactions;

  updateBalance(state.balance);
  renderOwnedPasses();
  renderTransactions();
  updateResetClock();
}

async function buyPass(typeId) {
  if (!currentUser) return;

  const type = passTypes.find(item => item.id === typeId);
  if (!type) return;

  const button = document.querySelector(`[data-buy="${typeId}"]`);
  if (button) button.disabled = true;

  try {
    const state = loadDemoState();

    if (state.balance < type.price) {
      toast("Not enough demo balance for this pass.");
      return;
    }

    const now = new Date();
    const pass = {
      id: makeId(),
      type: type.id,
      ownerUid: currentUser.uid,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      status: "active",
      expiresAt: type.days
        ? new Date(now.getTime() + type.days * 86400000).toISOString()
        : null
    };

    state.balance = Math.round((state.balance - type.price) * 100) / 100;
    state.passes.unshift(pass);

    addTransaction(state, "purchase", `${type.name} purchased`, type.price);
    saveDemoState(state);

    await loadDashboard();
    toast(`${type.name} purchased for ${dollars(type.price)}.`);
  } catch (error) {
    console.error(error);
    toast("Could not save demo data. Check browser storage settings.");
  } finally {
    if (button) button.disabled = false;
  }
}

function showTicket(passId) {
  const pass = ownedPasses.find(item => item.id === passId);
  if (!pass) return;

  const type = passTypes.find(item => item.id === pass.type) ||
    { name: "Transit Pass", duration: "Demo pass" };

  $("ticket-name").textContent = type.name;
  $("ticket-description").textContent = `${type.duration} · Demo ticket`;
  $("ticket-code").textContent = pass.id;
  $("ticket-status").textContent = getPassStatus(pass);
  $("ticket-qr").innerHTML = "";

  if (window.QRCode) {
    new QRCode($("ticket-qr"), {
      text: JSON.stringify({ passId: pass.id }),
      width: 200,
      height: 200,
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    $("ticket-qr").textContent = "QR library failed to load.";
  }

  $("ticket-dialog").showModal();
}

function showValidation(ok, title, detail, cooldownMs = 0) {
  $("validation-icon").textContent = ok ? "✓" : "×";
  $("validation-icon").className =
    `result-symbol ${ok ? "success" : "error"}`;
  $("validation-title").textContent = title;
  $("validation-detail").textContent = detail;
  $("cooldown-line").classList.toggle("hidden", !cooldownMs);

  if (cooldownMs) {
    $("cooldown-line").textContent =
      `Try again in ${Math.ceil(cooldownMs / 60000)} minute(s).`;
  }
}

async function validatePayload(raw) {
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    showValidation(false, "Invalid QR payload",
      "This code is not a valid Theta Transit demo pass.");
    return;
  }

  if (typeof payload.passId !== "string" || !payload.passId) {
    showValidation(false, "Pass ID missing",
      "The QR code does not contain a pass ID.");
    return;
  }

  if (!currentUser) {
    showValidation(false, "Sign-in required",
      "Sign in to validate your demo passes.");
    return;
  }

  const state = loadDemoState();
  const pass = state.passes.find(item => item.id === payload.passId);

  if (!pass) {
    showValidation(false, "PASS REJECTED",
      "This pass is not present in this browser's demo account.");
    return;
  }

  if (pass.expiresAt && Date.now() >= new Date(pass.expiresAt).getTime()) {
    showValidation(false, "PASS EXPIRED", "This demo pass has expired.");
    return;
  }

  if (pass.type === "single" && pass.lastUsedAt) {
    showValidation(false, "PASS ALREADY USED",
      "A Single Ride pass can only be accepted once.");
    return;
  }

  if (pass.lastUsedAt) {
    const elapsed = Date.now() - new Date(pass.lastUsedAt).getTime();
    const remaining = COOLDOWN_MS - elapsed;

    if (remaining > 0) {
      showValidation(false, "COOLDOWN ACTIVE",
        "This pass was scanned recently.", remaining);
      return;
    }
  }

  pass.lastUsedAt = new Date().toISOString();

  if (pass.type === "single") {
    pass.status = "used";
  }

  addTransaction(state, "validation", "Demo pass accepted", 0);
  saveDemoState(state);

  showValidation(true, "PASS ACCEPTED",
    "Demo pass accepted. The 15-minute anti-passback timer has started.");

  toast("Demo pass accepted.");
  await loadDashboard();
}

function friendlyError(error, fallback) {
  const code = error?.code || "";

  if (code.includes("auth/email-already-in-use")) {
    return "An account already exists for this email.";
  }

  if (
    code.includes("auth/invalid-credential") ||
    code.includes("auth/wrong-password") ||
    code.includes("auth/user-not-found")
  ) {
    return "Email or password is incorrect.";
  }

  if (code.includes("auth/weak-password")) {
    return "Use a password with at least 6 characters.";
  }

  return error?.message || fallback;
}

async function submitAuth(event) {
  event.preventDefault();

  if (PLACEHOLDER) {
    setMessage("auth-message",
      "Add your Firebase web app configuration to firebase-config.js.");
    return;
  }

  const email = $("email").value.trim();
  const password = $("password").value;

  $("auth-submit").disabled = true;

  try {
    if (authMode === "signup") {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }

    $("auth-form").reset();
    setMessage("auth-message", "", false);
  } catch (error) {
    setMessage("auth-message",
      friendlyError(error, "Could not sign in."));
  } finally {
    $("auth-submit").disabled = false;
  }
}

function initFirebase() {
  if (PLACEHOLDER) {
    $("auth-status").textContent = "Firebase setup required";
    setMessage("auth-message",
      "Add your Firebase config to firebase-config.js to enable accounts.");
    return;
  }

  app = initializeApp(firebaseConfig);
  auth = getAuth(app);

  onAuthStateChanged(auth, async user => {
    currentUser = user;

    if (!user) {
      $("auth-status").textContent = "Not signed in";
      ownedPasses = [];
      transactions = [];
      showAuth();
      return;
    }

    $("auth-status").textContent = user.email || "Signed in";
    showApp();

    try {
      await loadDashboard();
    } catch (error) {
      console.error(error);
      toast("Could not load the local demo data.");
    }
  });
}

document.querySelectorAll("[data-auth-mode]").forEach(button => {
  button.addEventListener("click", () => {
    authMode = button.dataset.authMode;

    document.querySelectorAll("[data-auth-mode]").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    $("auth-submit").textContent =
      authMode === "signup" ? "Create account" : "Sign in";

    $("password").autocomplete =
      authMode === "signup" ? "new-password" : "current-password";

    setMessage("auth-message", "", false);
  });
});

$("auth-form").addEventListener("submit", submitAuth);

$("logout-button").addEventListener("click", async () => {
  if (auth) await signOut(auth);
});

$("scroll-passes").addEventListener("click", () => {
  $("passes-section").scrollIntoView({ behavior: "smooth" });
});

$("close-ticket").addEventListener("click", () => {
  $("ticket-dialog").close();
});

$("manual-validate").addEventListener("click", () => {
  validatePayload($("manual-qr").value.trim());
});

$("start-scan").addEventListener("click", async () => {
  if (!window.Html5Qrcode) {
    toast("Camera scanner library failed to load.");
    return;
  }

  if (activeScanner) return;

  activeScanner = new Html5Qrcode("qr-reader");

  try {
    $("start-scan").disabled = true;
    $("stop-scan").disabled = false;

    await activeScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      async decoded => {
        await stopScanner();
        $("manual-qr").value = decoded;
        await validatePayload(decoded);
      },
      () => {}
    );
  } catch (error) {
    console.error(error);
    await stopScanner();
    toast("Camera access failed. Allow camera permission or paste a QR payload.");
  }
});

async function stopScanner() {
  if (activeScanner) {
    try {
      if (activeScanner.isScanning) await activeScanner.stop();
      await activeScanner.clear();
    } catch (error) {
      console.warn("Scanner cleanup:", error);
    }

    activeScanner = null;
  }

  $("start-scan").disabled = false;
  $("stop-scan").disabled = true;
}

$("stop-scan").addEventListener("click", stopScanner);

renderCatalog();
initFirebase();
updateResetClock();
setInterval(updateResetClock, 30000);

