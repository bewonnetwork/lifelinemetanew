const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// Firebase Admin Init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Landing Page ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// ── সব Users দেখো ──
app.get('/api/admin/users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User Delete ──
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await db.collection('users').doc(req.params.id).delete();
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User Block/Unblock ──
app.patch('/api/admin/users/:id/block', async (req, res) => {
  try {
    const { blocked } = req.body;
    await db.collection('users').doc(req.params.id).update({ blocked });
    res.json({ message: blocked ? 'User blocked' : 'User unblocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User Wallet দেখো ──
app.get('/api/admin/users/:id/wallet', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.id).get();
    res.json({ wallet: doc.data()?.wallet || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Wallet Update ──
app.patch('/api/admin/users/:id/wallet', async (req, res) => {
  try {
    const { amount } = req.body;
    await db.collection('users').doc(req.params.id).update({ wallet: amount });
    res.json({ message: 'Wallet updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Commission Change ──
app.patch('/api/admin/commission', async (req, res) => {
  try {
    const { commission } = req.body;
    await db.collection('settings').doc('global').set({ commission }, { merge: true });
    res.json({ message: 'Commission updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Notice পাঠাও ──
app.post('/api/admin/notice', async (req, res) => {
  try {
    const { title, message } = req.body;
    await db.collection('notices').add({
      title,
      message,
      createdAt: new Date().toISOString()
    });
    res.json({ message: 'Notice sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── সব Notices দেখো ──
app.get('/api/admin/notices', async (req, res) => {
  try {
    const snapshot = await db.collection('notices').get();
    const notices = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(notices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Notice Delete ──
app.delete('/api/admin/notices/:id', async (req, res) => {
  try {
    await db.collection('notices').doc(req.params.id).delete();
    res.json({ message: 'Notice deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Menu Add ──
app.post('/api/admin/menu', async (req, res) => {
  try {
    const { name, link, icon } = req.body;
    await db.collection('menus').add({ name, link, icon });
    res.json({ message: 'Menu added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Menu Delete ──
app.delete('/api/admin/menu/:id', async (req, res) => {
  try {
    await db.collection('menus').doc(req.params.id).delete();
    res.json({ message: 'Menu deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── সব Menus দেখো ──
app.get('/api/admin/menus', async (req, res) => {
  try {
    const snapshot = await db.collection('menus').get();
    const menus = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(menus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings দেখো ──
app.get('/api/admin/settings', async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.data() || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});