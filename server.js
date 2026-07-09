const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// ── Firebase Admin Init ──
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// ─────────────────────────────────────────────
//  SETTINGS (dynamic commission rates)
// ─────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('global').get();
    const defaults = {
      accountCharge: 30,
      reserveBalance: 5,
      referBonus: 4,
      cashbackRate: 3,
      cashbackCap: 60,
      matchingRate: 5,
      matchingCap: 1000,
      clubBonusRate: 4,
      clubTarget: 10,
      rankBonusRate: 4,
      roiMin: 12,
      roiMax: 15,
      investmentCommission: 5,
      withdrawSplit: 50,
      capitalLockMonths: 6,
    };
    res.json({ ...defaults, ...(doc.exists ? doc.data() : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/settings', async (req, res) => {
  try {
    await db.collection('settings').doc('global').set(req.body, { merge: true });
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  USERS — full list with stats
// ─────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', async (req, res) => {
  try {
    await db.collection('users').doc(req.params.id).update(req.body);
    res.json({ message: 'User updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user + all their subcollections
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const uid = req.params.id;
    // delete subcollections: investments, withdrawals, transactions, incomes
    const subcols = ['investments', 'withdrawals', 'transactions', 'incomes', 'fundRequests'];
    for (const col of subcols) {
      const snap = await db.collection('users').doc(uid).collection(col).get();
      for (const d of snap.docs) await d.ref.delete();
    }
    await db.collection('users').doc(uid).delete();
    // Also delete from auth
    try { await admin.auth().deleteUser(uid); } catch(e) {}
    res.json({ message: 'User and all data deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id/block', async (req, res) => {
  try {
    const { blocked } = req.body;
    await db.collection('users').doc(req.params.id).update({ blocked });
    res.json({ message: blocked ? 'User blocked' : 'User unblocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  FUND REQUESTS (user submits → admin approves → wallet credited)
// ─────────────────────────────────────────────
app.post('/api/fund-request', async (req, res) => {
  try {
    const { uid, amount, txHash, network, note } = req.body;
    if (!uid || !amount) return res.status(400).json({ error: 'uid and amount required' });

    const ref = await db.collection('fundRequests').add({
      uid,
      amount: Number(amount),
      txHash: txHash || '',
      network: network || 'TRC-20',
      note: note || '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ message: 'Fund request submitted', id: ref.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fund-requests/:uid', async (req, res) => {
  try {
    const snap = await db.collection('fundRequests')
      .where('uid', '==', req.params.uid)
      .orderBy('createdAt', 'desc')
      .get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/fund-requests', async (req, res) => {
  try {
    const snap = await db.collection('fundRequests').orderBy('createdAt', 'desc').get();
    // Enrich with user name
    const list = await Promise.all(snap.docs.map(async d => {
      const data = d.data();
      let userName = data.uid;
      try {
        const uDoc = await db.collection('users').doc(data.uid).get();
        if (uDoc.exists) userName = uDoc.data().fullName || uDoc.data().memberId || data.uid;
      } catch(e) {}
      return { id: d.id, ...data, userName, createdAt: data.createdAt?.toDate?.() || null };
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin approves fund request → credit wallet + log transaction
app.patch('/api/admin/fund-requests/:id/approve', async (req, res) => {
  try {
    const reqDoc = await db.collection('fundRequests').doc(req.params.id).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Request not found' });

    const data = reqDoc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const uid = data.uid;
    const amount = Number(data.amount);

    // Get settings for commission on investment
    const settingsDoc = await db.collection('settings').doc('global').get();
    const settings = { investmentCommission: 5, reserveBalance: 5, ...settingsDoc.data() };

    // Get current user wallet
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();

    const currentWallet = userData.wallet || 0;
    const currentInvestment = userData.totalInvestment || 0;

    // Calculate commission for investment
    const commissionRate = Number(settings.investmentCommission) / 100;
    const commissionAmount = parseFloat((amount * commissionRate).toFixed(2));
    const netAmount = parseFloat((amount - commissionAmount).toFixed(2));

    // Update user wallet
    await db.collection('users').doc(uid).update({
      wallet: currentWallet + netAmount,
      totalInvestment: currentInvestment + amount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Add income record for commission (to sponsor if exists)
    if (userData.sponsorId) {
      const sponsorSnap = await db.collection('users').where('memberId', '==', userData.sponsorId).get();
      if (!sponsorSnap.empty) {
        const sponsorDoc = sponsorSnap.docs[0];
        const sponsorData = sponsorDoc.data();
        const refBonus = Number(settings.referBonus || 4);
        await db.collection('users').doc(sponsorDoc.id).update({
          wallet: (sponsorData.wallet || 0) + refBonus,
          totalReferralIncome: (sponsorData.totalReferralIncome || 0) + refBonus,
        });
        await db.collection('transactions').add({
          uid: sponsorDoc.id,
          type: 'referral_bonus',
          amount: refBonus,
          fromUid: uid,
          description: `Referral bonus from ${userData.memberId || uid}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Log transaction for user
    await db.collection('transactions').add({
      uid,
      type: 'fund_approved',
      amount: netAmount,
      originalAmount: amount,
      commission: commissionAmount,
      commissionRate: settings.investmentCommission,
      description: `Fund deposit approved ($${amount} - ${settings.investmentCommission}% commission = $${netAmount})`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Mark fund request approved
    await db.collection('fundRequests').doc(req.params.id).update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      netCredited: netAmount,
      commissionDeducted: commissionAmount,
    });

    res.json({ message: 'Fund approved and wallet credited', netCredited: netAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/fund-requests/:id/reject', async (req, res) => {
  try {
    await db.collection('fundRequests').doc(req.params.id).update({
      status: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ message: 'Fund request rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  WITHDRAW REQUESTS
// ─────────────────────────────────────────────
app.post('/api/withdraw-request', async (req, res) => {
  try {
    const { uid, amount, walletAddress, network } = req.body;
    if (!uid || !amount || !walletAddress) return res.status(400).json({ error: 'Missing fields' });

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    const wallet = userData.wallet || 0;

    if (Number(amount) > wallet) return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct from wallet immediately (hold)
    await db.collection('users').doc(uid).update({
      wallet: wallet - Number(amount),
      walletHold: (userData.walletHold || 0) + Number(amount),
    });

    const ref = await db.collection('withdrawRequests').add({
      uid,
      amount: Number(amount),
      walletAddress,
      network: network || 'TRC-20',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Withdraw request submitted', id: ref.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/withdraw-requests/:uid', async (req, res) => {
  try {
    const snap = await db.collection('withdrawRequests')
      .where('uid', '==', req.params.uid)
      .orderBy('createdAt', 'desc')
      .get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/withdraw-requests', async (req, res) => {
  try {
    const snap = await db.collection('withdrawRequests').orderBy('createdAt', 'desc').get();
    const list = await Promise.all(snap.docs.map(async d => {
      const data = d.data();
      let userName = data.uid;
      try {
        const uDoc = await db.collection('users').doc(data.uid).get();
        if (uDoc.exists) userName = uDoc.data().fullName || uDoc.data().memberId || data.uid;
      } catch(e) {}
      return { id: d.id, ...data, userName, createdAt: data.createdAt?.toDate?.() || null };
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/withdraw-requests/:id/approve', async (req, res) => {
  try {
    const reqDoc = await db.collection('withdrawRequests').doc(req.params.id).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Not found' });
    const data = reqDoc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const uid = data.uid;
    const amount = Number(data.amount);

    // Get settings for 50/50 split
    const settingsDoc = await db.collection('settings').doc('global').get();
    const settings = { withdrawSplit: 50, ...settingsDoc.data() };
    const cashPercent = Number(settings.withdrawSplit) / 100;
    const cashOut = parseFloat((amount * cashPercent).toFixed(2));
    const redistributed = parseFloat((amount - cashOut).toFixed(2));

    // Release hold
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();
    await db.collection('users').doc(uid).update({
      walletHold: Math.max(0, (userData.walletHold || 0) - amount),
      totalWithdrawn: (userData.totalWithdrawn || 0) + cashOut,
    });

    await db.collection('transactions').add({
      uid,
      type: 'withdrawal_approved',
      amount: cashOut,
      redistributed,
      description: `Withdrawal: $${cashOut} sent, $${redistributed} redistributed`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('withdrawRequests').doc(req.params.id).update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      cashOut,
      redistributed,
    });

    res.json({ message: 'Withdrawal approved', cashOut, redistributed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/withdraw-requests/:id/reject', async (req, res) => {
  try {
    const reqDoc = await db.collection('withdrawRequests').doc(req.params.id).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'Not found' });
    const data = reqDoc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    // Refund hold back to wallet
    const userDoc = await db.collection('users').doc(data.uid).get();
    const userData = userDoc.data();
    await db.collection('users').doc(data.uid).update({
      wallet: (userData.wallet || 0) + Number(data.amount),
      walletHold: Math.max(0, (userData.walletHold || 0) - Number(data.amount)),
    });

    await db.collection('withdrawRequests').doc(req.params.id).update({
      status: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Withdrawal rejected, amount refunded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  TRANSACTIONS (all history)
// ─────────────────────────────────────────────
app.get('/api/transactions/:uid', async (req, res) => {
  try {
    const snap = await db.collection('transactions')
      .where('uid', '==', req.params.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(500).get();
    const list = await Promise.all(snap.docs.map(async d => {
      const data = d.data();
      let userName = data.uid;
      try {
        const uDoc = await db.collection('users').doc(data.uid).get();
        if (uDoc.exists) userName = uDoc.data().fullName || uDoc.data().memberId || data.uid;
      } catch(e) {}
      return { id: d.id, ...data, userName, createdAt: data.createdAt?.toDate?.() || null };
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ADMIN — Add balance manually
// ─────────────────────────────────────────────
app.patch('/api/admin/users/:id/add-balance', async (req, res) => {
  try {
    const { amount, note } = req.body;
    const userDoc = await db.collection('users').doc(req.params.id).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const newWallet = (userData.wallet || 0) + Number(amount);
    await db.collection('users').doc(req.params.id).update({ wallet: newWallet });
    await db.collection('transactions').add({
      uid: req.params.id,
      type: 'admin_credit',
      amount: Number(amount),
      description: note || 'Admin manual credit',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ message: 'Balance added', newWallet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ADMIN — Delete ALL data (test reset)
// ─────────────────────────────────────────────
app.delete('/api/admin/reset-all', async (req, res) => {
  try {
    const collections = ['users', 'transactions', 'fundRequests', 'withdrawRequests', 'notices'];
    for (const col of collections) {
      const snap = await db.collection(col).get();
      for (const d of snap.docs) await d.ref.delete();
    }
    res.json({ message: 'All data deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  NOTICES
// ─────────────────────────────────────────────
app.get('/api/notices', async (req, res) => {
  try {
    const snap = await db.collection('notices').orderBy('createdAt', 'desc').limit(20).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { title, message } = req.body;
    await db.collection('notices').add({ title, message, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ message: 'Notice sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/notices/:id', async (req, res) => {
  try {
    await db.collection('notices').doc(req.params.id).delete();
    res.json({ message: 'Notice deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  TREE / GENEALOGY
// ─────────────────────────────────────────────
app.get('/api/tree/:uid', async (req, res) => {
  try {
    const buildTree = async (uid, depth = 0) => {
      if (depth > 5) return null;
      const uDoc = await db.collection('users').doc(uid).get();
      if (!uDoc.exists) return null;
      const data = uDoc.data();
      const childSnap = await db.collection('users').where('sponsorId', '==', data.memberId || uid).get();
      const children = [];
      for (const child of childSnap.docs) {
        const childTree = await buildTree(child.id, depth + 1);
        if (childTree) children.push(childTree);
      }
      return {
        id: uid,
        memberId: data.memberId,
        fullName: data.fullName,
        rank: data.rank || 0,
        wallet: data.wallet || 0,
        totalInvestment: data.totalInvestment || 0,
        children,
      };
    };
    const tree = await buildTree(req.params.uid);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  USER PROFILE UPDATE
// ─────────────────────────────────────────────
app.patch('/api/user/:id/profile', async (req, res) => {
  try {
    const allowed = ['fullName', 'phone', 'country', 'walletAddress'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(req.params.id).update(update);
    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  STATIC ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ LIFELINEMETA Server running on port ' + PORT));