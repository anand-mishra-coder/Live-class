// firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    getFirestore,
    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    orderBy,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ==========================================
// FIREBASE CONFIG
// ==========================================

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCjA9mR5DoiUYGtgGrDuEL06yJHmcZZEEk",
  authDomain: "callapp-72e39.firebaseapp.com",
  projectId: "callapp-72e39",
  storageBucket: "callapp-72e39.firebasestorage.app",
  messagingSenderId: "888678726875",
  appId: "1:888678726875:web:d35640047a732eed4ba0fe",
  measurementId: "G-NV9BDKB2FZ"
};

// ==========================================
// INITIALIZE
// ==========================================

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);

const db = getFirestore(app);

const googleProvider = new GoogleAuthProvider();


// ==========================================
// EXPORT
// ==========================================

export {
    app,
    auth,
    db,
    googleProvider,

    signInWithPopup,
    signOut,
    onAuthStateChanged,

    collection,
    doc,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    orderBy,
    serverTimestamp
};
