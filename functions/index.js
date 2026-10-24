const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { randomUUID } = require("crypto");

initializeApp();
const db = getFirestore();
const DAILY_ALLOWANCE = 50;
const COOLDOWN_MS = 15 * 60 * 1000;
const PASS_TYPES = {
  single: { name: "Single Ride", price: 2.50, days: 1, modes: ["bus", "metro"], singleUse: true },
  bus_day: { name: "Bus Day Pass", price: 5.00, days: 1, modes: ["bus"] },
  metro_day: { name: "Metro Day Pass", price: 8.00, days: 1, modes: ["metro"] },
  all_day: { name: "All-Transit Day Pass", price: 12.00, days: 1, modes: ["bus", "metro"] },
  week: { name: "7-Day Pass", price: 25.00, days: 7, modes: ["bus", "metro"] },
  monthly: { name: "30-Day Pass", price: 45.00, days: 30, modes: ["bus", "metro"] }
};

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return request.auth.uid;
}
function etDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function newUserData(uid, dateKey) {
  return { uid, balance: DAILY_ALLOWANCE, walletResetDate: dateKey, createdAt: FieldValue.serverTimestamp() };
}
async function ensureWalletInTransaction(tx, userRef, uid) {
  const snap = await tx.get(userRef);
  const today = etDateKey();
  if (!snap.exists) {
    tx.set(userRef, newUserData(uid, today));
    return DAILY_ALLOWANCE;
  }
  const data = snap.data();
  if (data.walletResetDate !== today) {
    tx.update(userRef, { balance: DAILY_ALLOWANCE, walletResetDate: today });
    return DAILY_ALLOWANCE;
  }
  return Number(data.balance ?? DAILY_ALLOWANCE);
}

exports.ensureDailyWallet = onCall(async request => {
  const uid = requireAuth(request);
  const userRef = db.collection("users").doc(uid);
  const balance = await db.runTransaction(tx => ensureWalletInTransaction(tx, userRef, uid));
  return { balance, walletResetDate: etDateKey() };
});

exports.purchasePass = onCall(async request => {
  const uid = requireAuth(request);
  const type = request.data?.type;
  const passType = PASS_TYPES[type];
  if (!passType) throw new HttpsError("invalid-argument", "Unknown pass type.");
  const userRef = db.collection("users").doc(uid);
  const passRef = db.collection("passes").doc();
  const txRef = db.collection("transactions").doc();
  const now = new Date();
  const validUntil = Timestamp.fromDate(new Date(now.getTime() + passType.days * 24 * 60 * 60 * 1000));
  const result = await db.runTransaction(async tx => {
    const balance = await ensureWalletInTransaction(tx, userRef, uid);
    if (balance + 0.000001 < passType.price) throw new HttpsError("resource-exhausted", "Not enough daily credits.");
    const nextBalance = Math.round((balance - passType.price) * 100) / 100;
    tx.update(userRef, { balance: nextBalance });
    tx.set(passRef, {
      ownerUid: uid, type, name: passType.name, modes: passType.modes,
      status: "active", singleUse: !!passType.singleUse,
      createdAt: FieldValue.serverTimestamp(), validUntil,
      lastUsedAt: null, lastValidationId: null
    });
    tx.set(txRef, {
      uid, type: "purchase", amount: passType.price, passId: passRef.id,
      description: `${passType.name} purchased`, createdAt: FieldValue.serverTimestamp()
    });
    return { balance: nextBalance, passId: passRef.id };
  });
  return result;
});

exports.validatePass = onCall(async request => {
  const uid = requireAuth(request);
  const passId = request.data?.passId;
  if (typeof passId !== "string" || passId.length < 8 || passId.length > 128) {
    throw new HttpsError("invalid-argument", "Invalid pass ID.");
  }
  const passRef = db.collection("passes").doc(passId);
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(passRef);
    if (!snap.exists) return { accepted: false, message: "Pass not found." };
    const pass = snap.data();
    // This demo requires the passenger to be signed in as the pass owner.
    // For a public/anonymous gate validator, replace this with a separate, restricted validator role.
    if (pass.ownerUid !== uid) throw new HttpsError("permission-denied", "This pass belongs to another account.");
    const now = Date.now();
    if (pass.status !== "active") return { accepted: false, message: "This pass is not active." };
    if (pass.validUntil && pass.validUntil.toMillis() <= now) {
      tx.update(passRef, { status: "expired" });
      return { accepted: false, message: "This pass has expired." };
    }
    const lastUsed = pass.lastUsedAt?.toMillis ? pass.lastUsedAt.toMillis() : 0;
    const remaining = COOLDOWN_MS - (now - lastUsed);
    if (lastUsed && remaining > 0) {
      return { accepted: false, message: `Already scanned. Try again in ${Math.ceil(remaining / 60000)} minute(s).`, remainingMs: remaining };
    }
    if (pass.singleUse && lastUsed) {
      // Single-ride ticket cannot be reused at all after its initial successful scan.
      return { accepted: false, message: "This single-ride pass has already been used." };
    }
    const validationId = randomUUID();
    tx.update(passRef, { lastUsedAt: Timestamp.fromDate(new Date(now)), lastValidationId: validationId });
    const txRef = db.collection("transactions").doc();
    tx.set(txRef, {
      uid, type: "validation", amount: 0, passId,
      description: `${pass.name || "Transit pass"} validated`, createdAt: FieldValue.serverTimestamp()
    });
    return { accepted: true, message: "Valid demo pass. Scan recorded.", validationId };
  });
  return result;
});
