// Firebase SDK Import (v9 modular)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

// তোমার Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",
  authDomain: "livelinemeta.firebaseapp.com",
  projectId: "livelinemeta",
  storageBucket: "livelinemeta.appspot.com",   // ✅ ঠিক করা হলো
  messagingSenderId: "206900805598",
  appId: "1:206900805598:web:10e6b39100af201b4e674f"
};

// Firebase initialize
const app = initializeApp(firebaseConfig);

// Firestore connect
const db = getFirestore(app);

// Test: ডাটাবেজে ডাটা যোগ করা
async function addTestData() {
  try {
    await addDoc(collection(db, "test"), {
      name: "First Firebase Data",
      createdAt: new Date()
    });
    console.log("✅ Data added successfully!");
  } catch (error) {
    console.error("❌ Error adding data:", error);
  }
}

// Run test
addTestData();
