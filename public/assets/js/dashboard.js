// ===================== app.js =====================

// ================= FIREBASE IMPORT =================

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";


// ================= FIREBASE CONFIG =================

const firebaseConfig = {

  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",

  authDomain: "livelinemeta.firebaseapp.com",

  projectId: "livelinemeta",

  storageBucket: "livelinemeta.appspot.com",

  messagingSenderId: "206900805598",

  appId: "1:206900805598:web:10e6b39100af201b4e674f"

};


// ================= INITIALIZE =================

const app = initializeApp(firebaseConfig);

const db = getFirestore(app);

const auth = getAuth(app);


// ================= LOAD USER =================

onAuthStateChanged(auth, async(user)=>{

  if(user){

    // USER NAME
    document.getElementById("userName").innerText =
      user.displayName || "Member";

    // USER DATA
    const userRef = doc(db,"users",user.uid);

    const snap = await getDoc(userRef);

    // IF USER DATA EXISTS
    if(snap.exists()){

      const data = snap.data();

      document.getElementById("balance").innerText =
      "$" + (data.balance || 0);

    }

    // CREATE USER DATA IF NOT EXISTS
    else{

      await setDoc(userRef,{

        name:user.displayName || "Member",

        email:user.email,

        balance:2845.75,

        createdAt:new Date()

      });

      document.getElementById("balance").innerText =
      "$2845.75";

    }

  }

  else{

    window.location.href = "login.html";

  }

});


// ================= SECTION =================

window.showSection = function(section){

  alert(
    "🚀 " +
    section +
    " Section Coming Soon"
  );

};


// ================= INVEST =================

window.investNow = function(){

  let amount = prompt(
    "💰 Enter Investment Amount (USD)"
  );

  if(amount && !isNaN(amount)){

    alert(
      "✅ Investment Request Submitted Successfully\n\n" +
      "Amount: $" + amount
    );

  }

  else{

    alert("⚠️ Invalid Amount");

  }

};


// ================= WITHDRAW =================

window.withdrawNow = function(){

  let amount = prompt(
    "💸 Enter Withdrawal Amount"
  );

  if(amount && !isNaN(amount)){

    alert(
      "✅ Withdrawal Request Sent\n\n" +
      "Amount: $" + amount
    );

  }

  else{

    alert("⚠️ Invalid Amount");

  }

};


// ================= TEAM =================

window.showTeam = function(){

  alert(
    "👥 MY TEAM\n\n" +
    "Level 1 : 8 Members\n" +
    "Level 2 : 15 Members\n" +
    "Total Bonus : $685"
  );

};


// ================= HISTORY =================

window.showHistory = function(){

  alert(
    "📜 TRANSACTION HISTORY\n\n" +

    "• +$500 Investment\n" +

    "• +$120 ROI\n" +

    "• +$85 Referral Bonus"
  );

};


// ================= PROFILE =================

window.showProfile = function(){

  const user = auth.currentUser;

  if(user){

    alert(

      "👤 PROFILE\n\n" +

      "Name : " +
      (user.displayName || "Member") +

      "\n\nEmail : " +
      user.email

    );

  }

};


// ================= REFERRAL SYSTEM =================

window.copyReferral = async function(){

  const user = auth.currentUser;

  if(!user){

    alert("Please Login First");
    return;

  }

  // UNIQUE REF CODE
  const refCode = user.uid.substring(0,8);

  // REFERRAL LINK
  const referralLink =

    `${window.location.origin}/register.html?ref=${refCode}`;

  try{

    await navigator.clipboard.writeText(
      referralLink
    );

    alert(

      "🔗 Referral Link Copied Successfully\n\n" +

      referralLink +

      "\n\nEarn 10% Referral Bonus 💰"

    );

  }

  catch(error){

    prompt(
      "Copy Referral Link",
      referralLink
    );

  }

};


// ================= LOGOUT =================

window.logout = async function(){

  const confirmLogout = confirm(
    "Are you sure you want to logout?"
  );

  if(confirmLogout){

    await signOut(auth);

    window.location.href = "login.html";

  }

};