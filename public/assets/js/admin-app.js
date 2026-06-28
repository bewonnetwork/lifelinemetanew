import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  getDocs
} from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",
  authDomain: "livelinemeta.firebaseapp.com",
  projectId: "livelinemeta",
  storageBucket: "livelinemeta.appspot.com",
  messagingSenderId: "XXX",
  appId: "XXX"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);



// ================= SETTINGS UPDATE =================
window.updateSettings = async function () {
  const roi = prompt("Enter ROI (Example 15-20%)");
  const referral = prompt("Enter Referral Bonus (%)", "10");
  const fee = prompt("Registration Fee ($)", "20");

  await setDoc(doc(db, "settings", "global"), {
    roi,
    referralBonus: Number(referral),
    registrationFee: Number(fee)
  });

  alert("✅ Settings Updated Successfully!");
};


// ================= LOAD SETTINGS =================
window.loadSettings = async function () {
  const docSnap = await getDoc(doc(db, "settings", "global"));

  if (docSnap.exists()) {
    const data = docSnap.data();
    console.log("SETTINGS:", data);
  }
};


// ================= ADD PACKAGE =================
window.addPackage = async function () {
  const name = prompt("Package Name");
  const min = prompt("Min Investment");
  const roi = prompt("ROI %");

  await addDoc(collection(db, "packages"), {
    name,
    min: Number(min),
    roi,
    createdAt: new Date()
  });

  alert("✅ Package Added");
};


// ================= WITHDRAW APPROVE =================
window.approveWithdraw = async function (id) {
  await updateDoc(doc(db, "withdrawals", id), {
    status: "approved"
  });

  alert("Withdrawal Approved");
};


// ================= GET USERS =================
window.getUsers = async function () {
  const querySnapshot = await getDocs(collection(db, "users"));

  querySnapshot.forEach((doc) => {
    console.log(doc.id, doc.data());
  });
};