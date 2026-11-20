// src/firebase.ts
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database'; // 👈 Firestore 대신 getDatabase 임포트

const firebaseConfig = {
  apiKey: "AIzaSyCHeBnQDWGjL0t1hbAexa0LaPugUoVfu48",
  authDomain: "nextmalsm.firebaseapp.com",
  databaseURL: "https://nextmalsm-default-rtdb.firebaseio.com",
  projectId: "nextmalsm",
  storageBucket: "nextmalsm.firebasestorage.app",
  messagingSenderId: "863334383763",
  appId: "1:863334383763:web:a2ce159bb74dd29f0d0d66",
  measurementId: "G-49MY0QKHDL"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app); // 변수명을 편의상 db로 유지하거나 rtdb 등으로 export 하세요