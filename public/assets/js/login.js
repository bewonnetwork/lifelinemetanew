import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",
  authDomain: "livelinemeta.firebaseapp.com",
  projectId: "livelinemeta",
  storageBucket: "livelinemeta.appspot.com",
  messagingSenderId: "206900805598",
  appId: "1:206900805598:web:10e6b39100af201b4e674f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const form = document.getElementById("loginForm");
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const uid = userCredential.user.uid;

    // Firestore থেকে ইউজারের ডাটা পড়া
    const userDoc = await getDoc(doc(db, "users", uid));
    if (userDoc.exists()) {
      const userData = userDoc.data();
      alert("✅ Login successful!\nWelcome " + userData.fullName + "\nBalance: " + userData.balance);
      // Dashboard এ redirect
      window.location.href = "dashboard.html?uid=" + uid;
    } else {
      alert("No user data found!");
    }

  } catch (error) {
    alert("Error: " + error.message);
    console.error(error);
  }
});
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";
import { getFirestore, doc, setDoc, query, where, getDocs, collection } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";

// Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyA3G2bMOJ_HSDYXJPuM70tVjfbkHlMftr4",
  authDomain: "livelinemeta.firebaseapp.com",
  projectId: "livelinemeta",
  storageBucket: "livelinemeta.appspot.com",
  messagingSenderId: "206900805598",
  appId: "1:206900805598:web:10e6b39100af201b4e674f"
};

// Init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Show/Hide Password
document.querySelectorAll(".rn-eye").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const target=document.getElementById(btn.dataset.target);
    if(target.type==="password"){target.type="text";btn.textContent="HIDE";}
    else{target.type="password";btn.textContent="SHOW";}
  });
});

// Strength Checker
const password=document.getElementById("password");
const strengthBox=document.getElementById("strength");
password.addEventListener("input",()=>{
  const val=password.value;
  let msg="Weak";
  if(val.length>=8 && /[A-Z]/.test(val) && /\d/.test(val) && /[^A-Za-z0-9]/.test(val)) msg="Strong";
  else if(val.length>=6) msg="Normal";
  strengthBox.textContent="Password Strength: "+msg;
});

// Match Checker
const password2=document.getElementById("password2");
const matchBox=document.getElementById("match");
function checkMatch(){
  if(password2.value==="") matchBox.textContent="";
  else if(password.value===password2.value) matchBox.textContent="✅ Passwords Match";
  else matchBox.textContent="❌ Passwords Do Not Match";
}
password.addEventListener("input",checkMatch);
password2.addEventListener("input",checkMatch);

// Message Box
const messageBox=document.getElementById("message");
function showMessage(text,success=false){
  messageBox.style.color=success?"green":"red";
  messageBox.textContent=text;
}

// Register Submit
document.getElementById("registerForm").addEventListener("submit",async(e)=>{
  e.preventDefault();
  const fullName=document.getElementById("fullName").value.trim();
  const username=document.getElementById("username").value.trim();
  const email=document.getElementById("email").value.trim();
  const country=document.getElementById("country").value;
  const mobile=document.getElementById("mobile").value.trim();
  const refCode=document.getElementById("refCode").value.trim();
  const pass=password.value;
  const pass2=password2.value;

  if(pass!==pass2){showMessage("❌ Passwords do not match! Try Again.");return;}

  try{
    // Username check
    const q=query(collection(db,"users"),where("username","==",username));
    const snap=await getDocs(q);
    if(!snap.empty){showMessage("❌ Username already taken! Try Again.");return;}

    // Create user
    const userCredential=await createUserWithEmailAndPassword(auth,email,pass);
    const uid=userCredential.user.uid;

    // Save Firestore
    await setDoc(doc(db,"users",uid),{
      fullName,username,email,country,mobile,refCode,
      createdAt:new Date(),balance:0,referrals:[],investments:[],withdrawals:[]
    });

    showMessage("✅ Registration successful! Your User ID: "+uid,true);
    setTimeout(()=>{window.location.href="login.html?uid="+uid;},2000);

  }catch(error){
    if(error.code==="auth/email-already-in-use") showMessage("❌ Email already registered! Try Again.");
    else if(error.code==="auth/weak-password") showMessage("❌ Password too weak! Try Again.");
    else showMessage("❌ Error: "+error.message+" | Try Again.");
  }
});
