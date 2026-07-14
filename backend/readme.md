
# LifeLineMeta Backend (Render)

এই backend দুইটা কাজ করে:
1. **প্রতিদিন check করে** কার ৩০ দিনের সাইকেল পূরণ হয়েছে, prorated ROI + Rank Salary দেয় (condition না মিললে কিছুই দেয় না)
2. **Real on-chain payment verify করে** — Investment/Activation-এ কেউ Wallet Connect দিয়ে সত্যিকারের USDT পাঠালে, blockchain-এ (BscScan/TronGrid) চেক করে তারপর account credit করে

## ধাপ ১ — Firebase Service Account key বানান
Firebase Console → ⚙️ Project Settings → Service Accounts → **Generate new private key** → JSON ফাইল ডাউনলোড হবে। এই পুরো JSON ফাইলের কনটেন্ট লাগবে।

## ধাপ ২ — Render-এ Environment Variables সেট করুন
Render Dashboard → আপনার Service → Environment → নিচের গুলো যোগ করুন:

| Key | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | ধাপ ১-এর পুরো JSON ফাইলের কনটেন্ট (পুরোটা paste করুন, এক লাইনে হলেও সমস্যা নেই) |
| `FIREBASE_DATABASE_URL` | `https://livelinemeta-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `CRON_SECRET` | নিজে একটা র‍্যান্ডম শক্তিশালী পাসওয়ার্ড বানান (যেমন `a8f3k29xj...`) — এটা `/run-distribution` কে protect করবে |
| `BSCSCAN_API_KEY` | ফ্রি — https://bscscan.com/myapikey থেকে বানান |
| `ADMIN_WALLET_BEP` | আপনার BEP-20 (BSC) USDT ওয়ালেট অ্যাড্রেস (dashboard-এ যেটা দেখানো হয়) |
| `ADMIN_WALLET_TRC` | আপনার TRC-20 (TRON) USDT ওয়ালেট অ্যাড্রেস |

## ধাপ ৩ — Deploy
- Build Command: `npm install`
- Start Command: `npm start`

## ধাপ ৪ — দৈনিক ROI/Salary Auto-Run সেট করুন (গুরুত্বপূর্ণ!)
Render-এর ফ্রি Web Service ১৫ মিনিট idle থাকলে ঘুমিয়ে যায় — তাই ভেতরের node-cron একা ভরসাযোগ্য না। এর বদলে **ফ্রি external cron** ব্যবহার করুন:

1. https://cron-job.org -এ ফ্রি অ্যাকাউন্ট বানান
2. নতুন cron job বানান:
   - URL: `https://YOUR-RENDER-APP.onrender.com/run-distribution?secret=YOUR_CRON_SECRET`
   - Method: POST
   - Schedule: প্রতিদিন ১ বার (যেমন প্রতিদিন রাত ১২:১০টায়)
3. Save করুন — এখন প্রতিদিন এটা নিজে থেকে চলবে, ঘুমন্ত থাকলেও জাগিয়ে দেবে

## ধাপ ৫ — dashboard.html-এ Backend URL বসান
`dashboard.html` ফাইলে খুঁজুন:
```js
const BACKEND_URL = "https://YOUR-RENDER-APP.onrender.com";
```
এটাকে আপনার আসল Render URL দিয়ে বদলে দিন (Render দেওয়ার পর যে URL পাবেন, যেমন `https://lifelinemeta-backend.onrender.com`)।

## টেস্ট করবেন যেভাবে
- Browser-এ গিয়ে `https://YOUR-RENDER-APP.onrender.com` খুললে "LifeLineMeta backend is running" দেখা উচিত
- Distribution ম্যানুয়ালি টেস্ট করতে (Postman/curl দিয়ে):
```bash
curl -X POST "https://YOUR-RENDER-APP.onrender.com/run-distribution" \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

## ⚠️ নিরাপত্তা নোট
- `CRON_SECRET` কাউকে শেয়ার করবেন না — এটা ফাঁস হলে যে কেউ বারবার distribution চালিয়ে ভুল পেমেন্ট করতে পারবে
- `FIREBASE_SERVICE_ACCOUNT` অত্যন্ত স্পর্শকাতর — এটা দিয়ে আপনার পুরো Firebase প্রজেক্ট নিয়ন্ত্রণ করা যায়, কখনো public repo-তে commit করবেন না
