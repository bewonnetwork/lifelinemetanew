import { initializeApp } from
"https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";

import { getFirestore } from
"https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

import { getAuth } from
"https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";

const firebaseConfig = {

  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",

  authDomain: "livelinemeta.firebaseapp.com",

  projectId: "livelinemeta",

  storageBucket: "livelinemeta.appspot.com",

  messagingSenderId: "206900805598",

  appId: "1:206900805598:web:10e6b39100af201b4e674f"

};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

export const auth = getAuth(app);