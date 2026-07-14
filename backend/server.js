
/**
 * LifeLineMeta — Automatic Distribution Backend
 * ------------------------------------------------------------------
 * Runs on Render (or any Node host). Ports the same ROI + Rank Salary
 * logic that already exists in admin.html (runROIDistrib / runRankSalary)
 * to run server-side with the Firebase ADMIN SDK, so it can be triggered
 * automatically instead of requiring an admin to click a button.
 *
 * IMPORTANT — how the automatic 30-day cycle actually works:
 *   This script is designed to be triggered once a DAY (via an external
 *   cron ping — see README.md). Every time it runs, it checks EACH user
 *   individually: "how many days since your last payment / since you
 *   joined?" and pays a prorated slice of ROI / Rank Salary for those
 *   days (capped at 30). So a user's own personal 30-day cycle is
 *   respected even though the script itself just runs daily — you do
 *   NOT need a literal "wait exactly 30 days then fire once" scheduler.
 *
 *   If a user's team volume doesn't meet their rank's threshold, they
 *   are skipped entirely (no salary) until they qualify — this matches
 *   the "condition must pass before next salary" rule.
 * ------------------------------------------------------------------
 */

const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');

// ── FIREBASE ADMIN INIT ──────────────────────────────────────────
// Set these two environment variables on Render:
//   FIREBASE_SERVICE_ACCOUNT  -> the ENTIRE contents of your Firebase
//                                service account JSON key, pasted as one
//                                line (Render lets you paste multi-line
//                                values directly into an env var — just
//                                paste the whole JSON file content).
//   FIREBASE_DATABASE_URL     -> e.g. https://your-project-id-default-rtdb.firebaseio.com
// How to get the service account JSON:
//   Firebase Console -> Project Settings -> Service Accounts -> Generate new private key
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT environment variable. See README.md.');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const fsdb = admin.firestore();
const rtdb = admin.database();

const DAY_MS = 24 * 60 * 60 * 1000;

// ── HELPERS ───────────────────────────────────────────────────────
async function loadUsersMap() {
  const snap = await fsdb.collection('users').get();
  const map = {};
  snap.forEach(doc => { map[doc.id] = { id: doc.id, ...doc.data() }; });
  // Merge in the live RTDB financial fields (walletBalance, income, etc.)
  // that only exist in RTDB, not Firestore.
  const rtdbUsersSnap = await rtdb.ref('users').get();
  const rtdbUsers = rtdbUsersSnap.exists() ? rtdbUsersSnap.val() : {};
  for (const uid of Object.keys(map)) {
    const ru = rtdbUsers[uid] || {};
    map[uid].walletBalance = ru.walletBalance || 0;
    map[uid].income = ru.income || {};
    map[uid].rankSalaryLastPaidAt = ru.rankSalaryLastPaidAt || null;
  }
  return map;
}

async function loadInvestments() {
  const snap = await rtdb.ref('investments').get();
  const byUid = {}; // uid -> [ {pid, ...planData}, ... ]
  if (snap.exists()) {
    const all = snap.val();
    for (const uid of Object.keys(all)) {
      byUid[uid] = Object.entries(all[uid]).map(([pid, p]) => ({ pid, uid, ...p }));
    }
  }
  return byUid;
}

async function loadSettings() {
  const snap = await rtdb.ref('settings').get();
  return snap.exists() ? snap.val() : {};
}

// Sum of ALL active investment amounts under a user's subtree on one side
// (mirrors legInvestmentVolume() in admin.html)
function legInvestmentVolume(usersMap, invByUid, startUid, side) {
  const rootUser = usersMap[startUid];
  if (!rootUser) return 0;
  const startChild = side === 'left' ? rootUser.leftChild : rootUser.rightChild;
  if (!startChild) return 0;
  let total = 0;
  const stack = [startChild];
  const visited = new Set();
  while (stack.length) {
    const uid = stack.pop();
    if (!uid || visited.has(uid)) continue;
    visited.add(uid);
    const u = usersMap[uid];
    if (!u) continue;
    (invByUid[uid] || []).forEach(inv => {
      if (inv.status === 'active') total += parseFloat(inv.amount || 0);
    });
    if (u.leftChild) stack.push(u.leftChild);
    if (u.rightChild) stack.push(u.rightChild);
  }
  return total;
}

async function pushTransaction(uid, tx) {
  await rtdb.ref('transactions/' + uid).push({ ...tx, timestamp: Date.now() });
}

// Generation Bonus percentages — Gen 1: 1%, Gen 2-3: 0.75% each, Gen 4-10: 0.05% each
// (of the ROI amount). This mirrors what the dashboard's old self-claim button
// used to do — now folded into the daily auto-distribution so it only ever
// pays once per accrued day, never twice.
const GENERATION_PCT = [1, 0.75, 0.75, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];

async function distributeGenerationBonus(usersMap, startUid, roiAmount) {
  let currentUid = (usersMap[startUid] || {}).sponsorId;
  for (let g = 0; g < GENERATION_PCT.length; g++) {
    if (!currentUid || !usersMap[currentUid]) break;
    const bonus = roiAmount * (GENERATION_PCT[g] / 100);
    if (bonus > 0) {
      const gu = usersMap[currentUid];
      const iRef = rtdb.ref('users/' + currentUid + '/income/generation');
      const iSnap = await iRef.get();
      const newGen = parseFloat(iSnap.exists() ? iSnap.val() : 0) + bonus;
      await iRef.set(newGen);
      const wRef = rtdb.ref('users/' + currentUid + '/walletBalance');
      const wSnap = await wRef.get();
      const newBal = parseFloat(wSnap.exists() ? wSnap.val() : 0) + bonus;
      await wRef.set(newBal);
      await pushTransaction(currentUid, {
        type: 'Generation Bonus', amount: bonus,
        note: 'Gen ' + (g + 1) + ' auto ROI bonus (' + GENERATION_PCT[g] + '%)',
        status: 'completed', balance: newBal
      });
      if (gu) { gu.walletBalance = newBal; gu.income = gu.income || {}; gu.income.generation = newGen; }
    }
    currentUid = usersMap[currentUid].sponsorId;
  }
}

// ── ROI DISTRIBUTION (daily-safe, prorated) ─────────────────────
async function distributeROI(usersMap, invByUid, settings) {
  const now = Date.now();
  // 50% goes straight to the investor, 50% funds the 10-level Generation
  // Bonus above them — same split the old client-side "Claim ROI" button
  // used, now applied automatically per accrued day instead of once/month.
  const directPct = parseFloat(settings.roiDirectPct != null ? settings.roiDirectPct : 50) / 100;
  let paidCount = 0, totalPaid = 0;

  for (const uid of Object.keys(invByUid)) {
    const u = usersMap[uid];
    if (!u || u.incomeBlocked || u.isBanned) continue;

    for (const p of invByUid[uid]) {
      if (p.status !== 'active') continue;
      const since = p.lastROI || p.activatedAt || p.createdAt || now;
      const daysElapsed = Math.max(0, Math.floor((now - since) / DAY_MS));
      const daysToPay = Math.min(daysElapsed, 30);
      if (daysToPay <= 0) continue;

      const fullMonthly = (p.amount || 0) * (p.roiRate || settings.roiRate || 12) / 100;
      const monthly = fullMonthly * (daysToPay / 30);
      const directAmt = monthly * directPct;
      const genPoolAmt = monthly - directAmt;

      const newIncomeRoi = parseFloat(u.income.roi || 0) + directAmt;
      const newBal = parseFloat(u.walletBalance || 0) + directAmt;

      await rtdb.ref('users/' + uid + '/income/roi').set(newIncomeRoi);
      await rtdb.ref('users/' + uid + '/walletBalance').set(newBal);
      await rtdb.ref('investments/' + uid + '/' + p.pid).update({
        earnedROI: (p.earnedROI || 0) + monthly,
        lastROI: now
      });
      await pushTransaction(uid, {
        type: 'ROI Payout', amount: directAmt,
        note: daysToPay + '-day auto ROI (50%) on $' + p.amount,
        status: 'completed', balance: newBal
      });
      if (genPoolAmt > 0) await distributeGenerationBonus(usersMap, uid, monthly);

      // keep in-memory copy in sync for this run
      u.walletBalance = newBal;
      u.income.roi = newIncomeRoi;

      paidCount++; totalPaid += directAmt;
    }
  }
  return { paidCount, totalPaid };
}

// ── RANK SALARY DISTRIBUTION (daily-safe, prorated, condition-gated) ──
async function distributeRankSalary(usersMap, invByUid, settings) {
  const now = Date.now();
  const tiers = settings.rankSalaryTiers || {};
  const rankList = [5, 4, 3, 2, 1].map(n => ({ n, ...(tiers['rank' + n] || { leftVol: Infinity, rightVol: Infinity, salary: 0 }) }));
  let paidCount = 0, totalPaid = 0;

  for (const uid of Object.keys(usersMap)) {
    const u = usersMap[uid];
    if (!u.isActive || u.isBanned || u.incomeBlocked) continue;

    const leftVol = legInvestmentVolume(usersMap, invByUid, uid, 'left');
    const rightVol = legInvestmentVolume(usersMap, invByUid, uid, 'right');
    let matched = null;
    for (const r of rankList) {
      if (leftVol >= r.leftVol && rightVol >= r.rightVol) { matched = r; break; }
    }
    // Condition not met yet — no salary at all until they qualify.
    if (!matched || matched.salary <= 0) continue;

    const joinedAt = u.createdAt ? new Date(
      u.createdAt.toDate ? u.createdAt.toDate() : u.createdAt
    ).getTime() : now;
    const since = u.rankSalaryLastPaidAt || joinedAt;
    const daysElapsed = Math.max(0, Math.floor((now - since) / DAY_MS));
    const daysToPay = Math.min(daysElapsed, 30);
    if (daysToPay <= 0) continue;

    const proratedSalary = matched.salary * (daysToPay / 30);
    const newBal = parseFloat(u.walletBalance || 0) + proratedSalary;
    const newIncomeSalary = parseFloat(u.income.rankSalary || 0) + proratedSalary;

    await rtdb.ref('users/' + uid + '/walletBalance').set(newBal);
    await rtdb.ref('users/' + uid + '/income/rankSalary').set(newIncomeSalary);
    await rtdb.ref('users/' + uid).update({ currentRank: matched.n, rankSalaryLastPaidAt: now });
    await fsdb.collection('users').doc(uid).update({ rank: rankNameFromTierNumber(matched.n) }).catch(() => {});
    await pushTransaction(uid, {
      type: 'Rank Salary', amount: proratedSalary,
      note: 'Rank ' + matched.n + ' — ' + daysToPay + ' auto day(s) — L:$' + leftVol.toFixed(0) + ' R:$' + rightVol.toFixed(0),
      status: 'completed', balance: newBal
    });

    u.walletBalance = newBal;
    u.income.rankSalary = newIncomeSalary;
    u.rankSalaryLastPaidAt = now;

    paidCount++; totalPaid += proratedSalary;
  }
  return { paidCount, totalPaid };
}

function rankNameFromTierNumber(n) {
  // rank1..rank5 tier numbers map loosely onto the star-rank names used
  // in the UI. Adjust this mapping if your tiers represent different ranks.
  const names = { 1: 'One Star', 2: 'Two Star', 3: 'Three Star', 4: 'Four Star', 5: 'Five Star' };
  return names[n] || 'No Rank';
}

// ── MAIN RUNNER ───────────────────────────────────────────────────
async function runDailyDistribution() {
  console.log('[' + new Date().toISOString() + '] Running daily distribution…');
  const [usersMap, invByUid, settings] = await Promise.all([
    loadUsersMap(), loadInvestments(), loadSettings()
  ]);

  const roiResult = await distributeROI(usersMap, invByUid, settings);
  const salaryResult = await distributeRankSalary(usersMap, invByUid, settings);

  const summary = {
    timestamp: new Date().toISOString(),
    roi: roiResult,
    rankSalary: salaryResult
  };
  console.log('✅ Distribution complete:', JSON.stringify(summary));
  await rtdb.ref('autoDistributionLog').push({ ...summary, ts: Date.now() });
  return summary;
}

// ── ON-CHAIN PAYMENT VERIFICATION (real wallet connect → real check) ──
// ------------------------------------------------------------------
// WHY THIS EXISTS: the dashboard's "Connect Wallet" button can send a real
// USDT transaction on-chain, but the BROWSER can never be trusted to say
// "yes, I really sent it" — a modified page could skip the actual send and
// just claim success. So instant Investment/Activation from a wallet-connect
// payment must be verified HERE, server-side, by asking the blockchain
// itself (via BscScan for BEP-20, TronGrid for TRC-20) whether that exact
// transaction hash really moved the right amount of USDT to the admin's
// wallet. Only if that's true do we credit the user's account.
//
// Required environment variables on Render:
//   BSCSCAN_API_KEY   -> free key from https://bscscan.com/myapikey
//   ADMIN_WALLET_BEP  -> your BEP-20 (BSC) USDT receiving address
//   ADMIN_WALLET_TRC  -> your TRC-20 (TRON) USDT receiving address
// (USDT contract addresses are already hardcoded below — standard ones.)
const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function verifyBEP20Payment(txHash, expectedAmount) {
  const apiKey = process.env.BSCSCAN_API_KEY;
  const adminAddr = (process.env.ADMIN_WALLET_BEP || '').toLowerCase();
  if (!apiKey || !adminAddr) throw new Error('Server missing BSCSCAN_API_KEY or ADMIN_WALLET_BEP');

  const url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${USDT_BEP20_CONTRACT}&address=${adminAddr}&sort=desc&apikey=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== '1' || !Array.isArray(data.result)) {
    throw new Error('Could not reach BscScan / no transfers found yet');
  }
  const tx = data.result.find(t => t.hash.toLowerCase() === txHash.toLowerCase());
  if (!tx) return { ok: false, reason: 'Transaction not found yet on BscScan — it may still be confirming, try again in a minute.' };
  if (tx.to.toLowerCase() !== adminAddr) return { ok: false, reason: 'Transaction was not sent to the admin wallet address.' };
  const amount = Number(tx.value) / Math.pow(10, Number(tx.tokenDecimal || 18));
  if (amount + 0.000001 < expectedAmount) return { ok: false, reason: 'Amount sent ($' + amount.toFixed(2) + ') is less than the claimed amount ($' + expectedAmount + ').' };
  return { ok: true, amount, from: tx.from };
}

async function verifyTRC20Payment(txHash, expectedAmount) {
  const adminAddr = process.env.ADMIN_WALLET_TRC;
  if (!adminAddr) throw new Error('Server missing ADMIN_WALLET_TRC');

  const resp = await fetch(`https://api.trongrid.io/v1/transactions/${txHash}/events`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.data) || !data.data.length) {
    return { ok: false, reason: 'Transaction not found yet on TronGrid — it may still be confirming, try again in a minute.' };
  }
  const transferEvent = data.data.find(e => e.event_name === 'Transfer' && e.contract_address === USDT_TRC20_CONTRACT);
  if (!transferEvent) return { ok: false, reason: 'No USDT Transfer event found in this transaction.' };
  const toBase58 = transferEvent.result.to; // TronGrid returns hex/base58 depending on endpoint version
  const amount = Number(transferEvent.result.value) / 1e6;
  // TronGrid's "to" may come back as a hex-prefixed address; compare loosely
  // by checking the admin address appears in the result (base58 match is
  // safest — if this ever mismatches due to encoding, log and investigate).
  if (!toBase58 || !toBase58.toLowerCase().includes(adminAddr.slice(-10).toLowerCase())) {
    // Fall back to a looser check rather than silently accepting — flag for manual review instead.
    return { ok: false, reason: 'Could not confirm recipient address matches admin wallet — please contact support with this TxID for manual verification.' };
  }
  if (amount + 0.000001 < expectedAmount) return { ok: false, reason: 'Amount sent ($' + amount.toFixed(2) + ') is less than the claimed amount ($' + expectedAmount + ').' };
  return { ok: true, amount };
}

async function isTxHashAlreadyUsed(txHash) {
  const snap = await rtdb.ref('usedTxHashes/' + txHash).get();
  return snap.exists();
}
async function markTxHashUsed(txHash, uid) {
  await rtdb.ref('usedTxHashes/' + txHash).set({ uid, usedAt: Date.now() });
}

// ── EXPRESS APP ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('LifeLineMeta backend is running. POST /run-distribution to trigger payouts.');
});

// Real wallet-connect payment verification for Investment or Activation.
// The dashboard calls this AFTER the on-chain transaction is sent, passing
// the Firebase ID token (proves who's asking) + the txHash (proves what
// happened on-chain). We independently verify with BscScan/TronGrid before
// crediting anything — the browser's claim alone is never trusted.
app.post('/verify-payment', async (req, res) => {
  const { idToken, txHash, network, type, amount } = req.body || {};
  if (!idToken || !txHash || !network || !type || !amount) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  if (!['investment', 'activation'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid type' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired login — please refresh and try again.' });
  }
  const uid = decoded.uid;

  try {
    if (await isTxHashAlreadyUsed(txHash)) {
      return res.status(409).json({ ok: false, error: 'This transaction has already been used to credit an account.' });
    }

    const claimedAmount = parseFloat(amount);
    const verify = network === 'BEP-20'
      ? await verifyBEP20Payment(txHash, claimedAmount)
      : network === 'TRC-20'
      ? await verifyTRC20Payment(txHash, claimedAmount)
      : { ok: false, reason: 'Unknown network' };

    if (!verify.ok) {
      return res.status(402).json({ ok: false, error: verify.reason });
    }

    // Verified on-chain — now apply the same logic dashboard.html uses for
    // P2P Wallet investment/activation, just funded by a real payment instead.
    const userDoc = await fsdb.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'User not found' });
    const u = { id: uid, ...userDoc.data() };
    const rtdbSnap = await rtdb.ref('users/' + uid).get();
    const ru = rtdbSnap.exists() ? rtdbSnap.val() : {};
    const settings = await loadSettings();

    await markTxHashUsed(txHash, uid);

    if (type === 'activation') {
      if (ru.isActive) return res.json({ ok: true, note: 'Already active — payment verified but no action needed.' });
      await rtdb.ref('users/' + uid + '/isActive').set(true);
      await fsdb.collection('users').doc(uid).update({ isActive: true, activatedAt: new Date() });
      await rtdb.ref('transactions/' + uid).push({
        type: 'Activation Payment', amount: -claimedAmount,
        note: 'Real on-chain payment (' + network + ') — verified — TxID ' + txHash,
        timestamp: Date.now(), status: 'completed'
      });
      const sponsorBonus = parseFloat(settings.activationRefBonus != null ? settings.activationRefBonus : 5);
      if (u.sponsorId && sponsorBonus > 0) {
        const sRef = rtdb.ref('users/' + u.sponsorId + '/walletBalance');
        const sSnap = await sRef.get();
        const sNewBal = parseFloat(sSnap.exists() ? sSnap.val() : 0) + sponsorBonus;
        await sRef.set(sNewBal);
        await rtdb.ref('users/' + u.sponsorId + '/income/sponsor').set(
          parseFloat((await rtdb.ref('users/' + u.sponsorId + '/income/sponsor').get()).val() || 0) + sponsorBonus
        );
        await pushTransaction(u.sponsorId, { type: 'Sponsor Commission', amount: sponsorBonus, note: 'Activation bonus (on-chain verified)', status: 'completed', balance: sNewBal });
      }
      return res.json({ ok: true, note: 'Activated!' });
    }

    if (type === 'investment') {
      const minInv = parseFloat(settings.minInvestment || 100);
      if (claimedAmount < minInv) return res.status(400).json({ ok: false, error: 'Below minimum investment of $' + minInv });

      await rtdb.ref('investments/' + uid).push({
        amount: claimedAmount, method: 'On-chain (' + network + ')', txid: txHash,
        roiRate: settings.roiRate || 12, status: 'active', activatedAt: Date.now(), earnedROI: 0, createdAt: Date.now()
      });
      const newInv = parseFloat(u.totalInvested || 0) + claimedAmount;
      await rtdb.ref('users/' + uid + '/totalInvested').set(newInv);
      await fsdb.collection('users').doc(uid).update({ totalInvested: newInv });

      const refPct = parseFloat(settings.investRefPct || 5) / 100;
      const commAmt = claimedAmount * refPct;
      if (u.sponsorId && commAmt > 0) {
        const sRef = rtdb.ref('users/' + u.sponsorId + '/walletBalance');
        const sSnap = await sRef.get();
        const sNewBal = parseFloat(sSnap.exists() ? sSnap.val() : 0) + commAmt;
        await sRef.set(sNewBal);
        const sIRef = rtdb.ref('users/' + u.sponsorId + '/income/directInvestComm');
        const sISnap = await sIRef.get();
        await sIRef.set(parseFloat(sISnap.exists() ? sISnap.val() : 0) + commAmt);
        await pushTransaction(u.sponsorId, { type: 'Direct Investment Commission', amount: commAmt, note: (refPct * 100) + '% of $' + claimedAmount + ' (on-chain verified)', status: 'completed', balance: sNewBal });
      }

      await pushTransaction(uid, { type: 'Investment Payment', amount: -claimedAmount, note: 'Real on-chain payment (' + network + ') — verified — TxID ' + txHash, status: 'completed' });

      if (!ru.isActive) {
        await rtdb.ref('users/' + uid + '/isActive').set(true);
        await fsdb.collection('users').doc(uid).update({ isActive: true, activatedAt: new Date() });
      }
      return res.json({ ok: true, note: 'Invested $' + claimedAmount + '!' });
    }
  } catch (e) {
    console.error('verify-payment error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Protected endpoint — call this once a day from a free external cron
// service (cron-job.org, EasyCron, or Render's own "Cron Job" resource).
// This is more reliable on Render's FREE plan than relying on node-cron
// inside a Web Service, because free Web Services sleep after ~15 minutes
// of no incoming traffic — an external ping both wakes the service up
// AND triggers the run in one request.
// ── ONE-TIME MIGRATION: merge old buggy client-side "Salary" claims ──────
// The dashboard used to have a self-claim Salary button that wrote to
// users/{uid}/income/salary using WRONG hardcoded tier amounts, and could
// double-pay against the new automatic Rank Salary system. This endpoint
// moves any old income/salary balance into the correct income/rankSalary
// field (so lifetime totals stay accurate) and zeroes out the old field so
// it can't be confused with real data going forward. It also matches each
// moved amount with a transaction record for a clean audit trail.
// Run this ONCE, then you never need it again — safe to call twice (it's a
// no-op the second time since income/salary will already be zero).
app.post('/migrate-old-salary-field', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or wrong x-cron-secret' });
  }
  try {
    const snap = await rtdb.ref('users').get();
    if (!snap.exists()) return res.json({ ok: true, migrated: 0, note: 'No users found.' });

    const allUsers = snap.val();
    let migratedCount = 0;
    let totalMoved = 0;
    const details = [];

    for (const uid of Object.keys(allUsers)) {
      const u = allUsers[uid];
      const oldSalary = parseFloat((u.income && u.income.salary) || 0);
      if (oldSalary <= 0) continue; // nothing to migrate for this user

      const newRankSalary = parseFloat((u.income && u.income.rankSalary) || 0) + oldSalary;
      await rtdb.ref('users/' + uid + '/income/rankSalary').set(newRankSalary);
      await rtdb.ref('users/' + uid + '/income/salary').set(0);

      await pushTransaction(uid, {
        type: 'Rank Salary', amount: 0, // no new money — just relabeling, wallet balance untouched
        note: 'One-time migration: $' + oldSalary.toFixed(2) + ' moved from old "Salary" record into Rank Salary total (no balance change, correcting a display bug)',
        status: 'completed'
      });

      migratedCount++;
      totalMoved += oldSalary;
      details.push({ uid, amount: oldSalary });
    }

    console.log('✅ Salary field migration complete:', migratedCount, 'users, $' + totalMoved.toFixed(2));
    res.json({ ok: true, migratedCount, totalMoved: totalMoved.toFixed(2), details });
  } catch (e) {
    console.error('migrate-old-salary-field error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/run-distribution', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or wrong x-cron-secret' });
  }
  try {
    const summary = await runDailyDistribution();
    res.json({ ok: true, summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Optional: also try an internal daily schedule (00:10 server time) as a
// backup, IN CASE the service happens to be awake at that moment. This is
// NOT reliable alone on Render's free tier — keep the external cron ping
// above as your primary trigger.
cron.schedule('10 0 * * *', () => {
  runDailyDistribution().catch(err => console.error('Scheduled run failed:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port ' + PORT));
