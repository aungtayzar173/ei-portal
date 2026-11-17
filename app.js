/* လျှပ်စစ်စစ်ဆေးရေးဌာန — single-page app (Firebase v10 modular SDK via CDN)
   No native dialog functions are used anywhere — all feedback is in-page. */

import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider,
  sendPasswordResetEmail, signOut, updatePassword
} from "firebase/auth";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, getDocs, serverTimestamp, Timestamp, writeBatch
} from "firebase/firestore";
/* NOTE: Firebase Storage is NOT used (it requires the Blaze billing plan).
   Direct library uploads are stored inside Firestore itself, split into
   base64 chunks under libraryFiles/{fileId}/chunks (owner decision
   2026-11-16 — the no-card method, so the Admin Team can upload PDFs
   directly). Library items may instead link to a bundled /library-files/
   path or any URL. */

/* ---------- Firebase config (project ei-portal-417d4) ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyDEyBR_Y9V8S2sbUEtXNVfqLUbUycaEs34",
  authDomain: "ei-portal-417d4.firebaseapp.com",
  projectId: "ei-portal-417d4",
  storageBucket: "ei-portal-417d4.firebasestorage.app",
  messagingSenderId: "348414639159",
  appId: "1:348414639159:web:c8b0ff472df1817ff753b2"
};

const SUPER_ADMIN_EMAIL = "aungtayzar51282@gmail.com";
const EMAILJS_SERVICE_ID = "service_252p1cz";
const EMAILJS_TEMPLATE_ID = "template_eij4uz8";
const EMAILJS_PUBLIC_KEY = "hZ4uTdFvx2b1Gx_5-";
const AUTHOR_LABEL = "Admin Team";
const LIBRARY_CATEGORIES = ["လုပ်ထုံးလုပ်နည်းများ", "ဥပဒေ·နည်းဥပဒေ", "စစ်ဆေးရေးလမ်းညွှန်", "အခြား"];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; /* direct-upload cap: 100 MB (soft cap; total free Firestore space ≈ 1 GB) */
const CHUNK_RAW_BYTES = 500 * 1024;        /* per Firestore chunk doc (base64 ≈ 683 KB < 1 MiB) */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

/* ---------- App state ---------- */
const state = {
  user: null,        // Firebase Auth user
  profile: null,     // users/{uid} document data
  authReady: false
};

function isSuper() {
  return !!(state.user && state.user.email && state.user.email.toLowerCase() === SUPER_ADMIN_EMAIL);
}
function effectiveRole() {
  if (!state.user) return null;
  if (isSuper()) return "admin";
  return state.profile ? (state.profile.role || "pending") : "pending";
}
function isApprovedMember() {
  if (!state.user) return false;
  if (isSuper()) return true;
  const r = effectiveRole();
  return ["member", "deputy", "admin"].includes(r) && !(state.profile && state.profile.disabled);
}
function isStaff() {
  if (!state.user) return false;
  if (isSuper()) return true;
  const r = effectiveRole();
  return ["deputy", "admin"].includes(r) && !(state.profile && state.profile.disabled);
}

/* ---------- Helpers ---------- */
const $view = () => document.getElementById("view");
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const MY_DIGITS = ["၀", "၁", "၂", "၃", "၄", "၅", "၆", "၇", "၈", "၉"];
function myNum(n) { return String(n).replace(/[0-9]/g, d => MY_DIGITS[Number(d)]); }
function toDate(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (v && typeof v.seconds === "number") return new Date(v.seconds * 1000);
  return null;
}
function fmtDate(v) {
  const d = toDate(v);
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return myNum(dd + "." + mm + "." + d.getFullYear());
}
function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return fmtDate(d) + " " + myNum(hh + ":" + mi);
}
function isNew(v) {
  const d = toDate(v);
  return d ? (Date.now() - d.getTime()) < 7 * 24 * 3600 * 1000 : false;
}
function notExpired(item) {
  const e = toDate(item.expiresAt);
  return !e || e.getTime() >= Date.now();
}
function fmtSize(bytes) {
  const b = Number(bytes || 0);
  if (!b) return "";
  if (b < 1024) return myNum(b) + " B";
  if (b < 1024 * 1024) return myNum((b / 1024).toFixed(1)) + " KB";
  return myNum((b / (1024 * 1024)).toFixed(2)) + " MB";
}
function sortByCreatedDesc(list) {
  return list.slice().sort((a, b) => {
    const ta = toDate(a.createdAt), tb = toDate(b.createdAt);
    return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
  });
}
function pinnedFirst(list) {
  return list.slice().sort((a, b) => {
    const p = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (p !== 0) return p;
    const ta = toDate(a.createdAt), tb = toDate(b.createdAt);
    return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
  });
}
/* In-page message box (replaces native dialogs) */
function msgHtml(id) { return '<div class="msg" id="' + id + '"></div>'; }
function showMsg(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = "msg show " + (kind || "info");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function friendlyError(e) {
  const code = (e && e.code) || "";
  const map = {
    "auth/invalid-email": "Email ပုံစံ မမှန်ပါ။",
    "auth/user-not-found": "ဤ Email ဖြင့် အကောင့် မရှိပါ။",
    "auth/wrong-password": "Password မမှန်ပါ။",
    "auth/invalid-credential": "Email သို့မဟုတ် Password မမှန်ပါ။",
    "auth/email-already-in-use": "ဤ Email ဖြင့် အကောင့် ရှိပြီးသား ဖြစ်သည်။ Login ဝင်ပါ။",
    "auth/weak-password": "Password အားနည်းလွန်းသည် — အနည်းဆုံး ၆ လုံး ထားပါ။",
    "auth/popup-closed-by-user": "Google ဝင်ခြင်း ပိတ်သွားသည် — ထပ်ကြိုးစားပါ။",
    "auth/requires-recent-login": "လုံခြုံရေးအရ ထပ်မံ Login ဝင်ပြီးမှ Password ပြောင်းနိုင်သည်။ Logout လုပ်ပြီး ပြန်ဝင်ပါ။",
    "permission-denied": "ဤလုပ်ဆောင်ချက်ကို ခွင့်ပြုချက် မရှိပါ။",
    "unavailable": "ဆာဗာနှင့် ဆက်သွယ်၍ မရပါ — အင်တာနက် စစ်ပြီး ထပ်ကြိုးစားပါ။"
  };
  return map[code] || ("တစ်ခုခု မှားသွားသည် (" + (code || "unknown") + ") — ထပ်ကြိုးစားပါ။");
}

/* ---------- Download logging (best-effort, never blocks) ---------- */
async function logDownload(entry) {
  try {
    await addDoc(collection(db, "downloads"), {
      kind: entry.kind || "apk",
      name: entry.name || "",
      version: entry.version || "",
      uid: state.user ? state.user.uid : "guest",
      email: state.user ? (state.user.email || "") : "",
      at: serverTimestamp()
    });
  } catch (e) { /* logging must never block a download */ }
}

/* ---------- Router ---------- */
function parseRoute() {
  const h = (location.hash || "#/").replace(/^#/, "");
  const parts = h.split("/").filter(x => x.length > 0);
  return parts; // e.g. [] home, ["software"], ["library-item","ID"]
}
function navTo(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
window.addEventListener("hashchange", render);

function renderNav() {
  const nav = document.getElementById("mainnav");
  const r = parseRoute();
  const cur = r[0] || "";
  const links = [];
  const item = (hash, label, key) =>
    '<a href="' + hash + '"' + (cur === key ? ' class="on"' : "") + ">" + label + "</a>";
  links.push(item("#/", "🏠 ပင်မ", ""));
  links.push(item("#/software", "🧰 Software များ", "software"));
  links.push(item("#/announcements", "📢 ကြေညာချက်များ", "announcements"));
  links.push(item("#/guidelines", "📌 လမ်းညွှန်များ", "guidelines"));
  if (isApprovedMember()) {
    links.push(item("#/member", "👤 အဖွဲ့ဝင်ပင်မ", "member"));
    links.push(item("#/library", "📚 Library", "library"));
    links.push(item("#/internal", "📢 ဌာနတွင်း", "internal"));
    links.push(item("#/directory", "👥 အဖွဲ့ဝင်စာရင်း", "directory"));
    links.push(item("#/account", "⚙️ Account", "account"));
    if (isStaff()) links.push(item("#/admin", "🛠 Admin", "admin"));
  } else if (state.user) {
    links.push(item("#/waiting", "⏳ စောင့်ဆိုင်းဆဲ", "waiting"));
  } else {
    links.push(item("#/login", "🔐 Login", "login"));
  }
  nav.innerHTML = '<div class="row">' + links.join("") + "</div>";
}

async function render() {
  renderNav();
  const r = parseRoute();
  const page = r[0] || "";
  const view = $view();
  if (!state.authReady) {
    view.innerHTML = '<div class="loading">⏳ ခေတ္တ စောင့်ပေးပါ…</div>';
    return;
  }
  try {
    if (page === "") return viewHome(view);
    if (page === "software") return viewSoftware(view);
    if (page === "announcements") return viewAnnouncements(view);
    if (page === "guidelines") return viewGuidelines(view);
    if (page === "announcement") return viewAnnouncementDetail(view, r[1]);
    if (page === "login") return viewLogin(view);
    if (page === "waiting") return viewWaiting(view);
    if (page === "member") return viewMemberHome(view);
    if (page === "library") return viewLibrary(view);
    if (page === "library-item") return viewLibraryItem(view, r[1]);
    if (page === "internal") return viewInternal(view);
    if (page === "directory") return viewDirectory(view);
    if (page === "account") return viewAccount(view);
    if (page === "admin") return viewAdmin(view, r[1] || "approvals");
    view.innerHTML = '<div class="card"><h2>စာမျက်နှာ မတွေ့ပါ</h2><p><a href="#/">← ပင်မသို့</a></p></div>';
  } catch (e) {
    view.innerHTML = '<div class="card"><h2>ဖွင့်၍ မရပါ</h2><p class="note">' +
      esc(friendlyError(e)) + '</p><p><a href="#/">← ပင်မသို့</a></p></div>';
  }
  window.scrollTo(0, 0);
}

/* Access guards used by member/admin views */
function guardMember(view) {
  if (!state.user) {
    view.innerHTML = '<div class="card"><h2>🔒 Login လိုအပ်သည်</h2>' +
      '<p class="note">ဤအပိုင်းကို အဖွဲ့ဝင်များသာ ကြည့်နိုင်သည်။</p>' +
      '<p style="margin-top:10px"><a class="btn btn-gold" href="#/login">🔐 Login ဝင်ရန်</a></p></div>';
    return false;
  }
  if (!isApprovedMember()) { navTo("#/waiting"); return false; }
  return true;
}
function guardStaff(view) {
  if (!guardMember(view)) return false;
  if (!isStaff()) {
    view.innerHTML = '<div class="card"><h2>🔒 ခွင့်ပြုချက် မရှိပါ</h2>' +
      '<p class="note">ဤအပိုင်းကို Admin Team သာ သုံးနိုင်သည်။</p></div>';
    return false;
  }
  return true;
}

/* ================= PUBLIC ZONE ================= */

/* Software list — real download URLs from the ATZ download site
   (https://aungtayzar173.github.io/, hrefs as published there) */
const ATZ_BASE = "https://aungtayzar173.github.io/";
const APPS = [
  { icon: "🔌", name: "ATZ Transformer Test (≤315 kVA)", desc: "315 kVA နှင့် အောက်", version: "1.6",
    apk: "ATZ-TransformerTest-315-v1.6.apk", pc: "ATZ-Transformer-315-PC.html", size: "242,644 B" },
  { icon: "⚡", name: "ATZ Transformer Test (≥500 kVA)", desc: "500 kVA နှင့် အထက်", version: "2.10",
    apk: "ATZ-TransformerTest-500-v2.10.apk", pc: "ATZ-Transformer-500-PC.html", size: "246,725 B" },
  { icon: "🏠", name: "ATZ Internal Wiring Check", desc: "အတွင်းပိုင်း ဝါယာရိန်း စစ်ဆေးချက်", version: "2.5",
    apk: "ATZ-InternalWiringCheck-v2.5.apk", pc: "ATZ-InternalWiring-PC.html", size: "373,779 B" },
  { icon: "🏭", name: "ATZ စက်ရုံ/အလုပ်ရုံ စစ်ဆေးခြင်း", desc: "စက်ရုံ/အလုပ်ရုံ လျှပ်စစ် စစ်ဆေးချက်", version: "1.8",
    apk: "ATZ-FactoryCheck-v1.8.apk", pc: "ATZ-Factory-PC.html", size: "172,997 B" },
  { icon: "☀️", name: "ATZ Solar Test", desc: "Solar PV စစ်ဆေးခြင်း", version: "2.0",
    apk: "ATZ-SolarTest-v2.0.apk", pc: "ATZ-SolarTest-PC.html", size: "369,611 B" },
  { icon: "🧰", name: "ATZ Installer Toolkit", desc: "အိမ်သုံး + မီးဆရာ တွက်ချက်မှုများ", version: "1.7",
    apk: "ATZ-InstallerToolkit-v1.7.apk", pc: "ATZ-InstallerToolkit-PC.html", size: "226,245 B" },
  { icon: "🛗", name: "ATZ ဓါတ်လှေကား စစ်ဆေးခြင်း (အဟောင်း)", desc: "နှစ်စဉ် သက်တမ်းတိုး စစ်ဆေးချက်", version: "2.1",
    apk: "ATZ-ElevatorCheck-Old-v2.1.apk", pc: "ATZ-Elevator-Old-PC.html", size: "291,790 B" },
  { icon: "💰", name: "ATZ ဝင်ငွေ ထွက်ငွေ", desc: "နေ့စဉ် ပိုက်ဆံ မှတ်တမ်း", version: "1.4",
    apk: "ATZ-MoneyLedger-v1.4.apk", pc: "ATZ-MoneyLedger-PC.html", size: "74,693 B" }
];

async function fetchAnnouncements(audience) {
  const snap = await getDocs(query(collection(db, "announcements"), where("audience", "==", audience)));
  const list = [];
  snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
  return list.filter(notExpired);
}
async function fetchGuidelines() {
  const snap = await getDocs(collection(db, "guidelines"));
  const list = [];
  snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
  return list.filter(notExpired);
}
function annBlock(a, linkable) {
  const title = linkable
    ? '<a href="#/announcement/' + a.id + '">' + esc(a.title) + "</a>"
    : esc(a.title);
  return '<div class="ann">' +
    '<span class="dt">' + fmtDate(a.createdAt) + "</span> " +
    (a.pinned ? '<span class="badge navy">📌 အရေးကြီး</span> ' : "") +
    (isNew(a.createdAt) ? '<span class="badge">အသစ်</span>' : "") +
    '<b class="t">' + title + "</b>" +
    '<p class="note">' + esc(a.body || "") + "</p>" +
    '<p class="note">တင်သူ: ' + AUTHOR_LABEL + "</p></div>";
}

async function viewHome(view) {
  view.innerHTML =
    '<div class="card"><h2>👋 ကြိုဆိုပါသည်</h2>' +
    '<p>လျှပ်စစ်စစ်ဆေးရေးဌာန၏ ဝန်ထမ်းများအတွက် စစ်ဆေးရေးသုံး Software များ၊ ကြေညာချက်များနှင့် အရေးကြီး လမ်းညွှန်များကို ဤနေရာတွင် စုစည်း တင်ပြထားပါသည်။ စာအုပ်/လုပ်ထုံးများနှင့် ဌာနတွင်း ကြေညာချက်များမှာ အဖွဲ့ဝင်များသာ ဝင်ဖတ်နိုင်သည်။</p>' +
    (state.user ? "" : '<p style="margin-top:12px"><a class="btn btn-gold" href="#/login">🔐 Login</a></p>') +
    "</div>" +
    '<div class="topnav">' +
    '<a href="#/software">🧰 Software များ</a>' +
    '<a href="#/announcements">📢 ကြေညာချက်များ</a>' +
    '<a href="#/guidelines">📌 လမ်းညွှန်များ</a>' +
    "</div>" +
    '<div class="card"><h2>📢 ကြေညာချက် အသစ်များ</h2><div id="home-ann"><p class="note">⏳ ဖတ်နေသည်…</p></div>' +
    '<p style="margin-top:8px"><a class="linkish" href="#/announcements">ကြေညာချက် အားလုံး ကြည့်ရန် →</a></p></div>' +
    '<div class="card"><h2>📌 အရေးကြီး လမ်းညွှန်</h2><div id="home-guide"><p class="note">⏳ ဖတ်နေသည်…</p></div>' +
    '<p style="margin-top:8px"><a class="linkish" href="#/guidelines">လမ်းညွှန်များ အားလုံး ကြည့်ရန် →</a></p></div>' +
    '<div class="card"><h2>📞 ဆက်သွယ်ရန်</h2>' +
    '<p>ဖုန်း / Viber / Telegram: <b>09428121483</b></p>' +
    '<p>Email: <b>aungtayzar51282@gmail.com</b></p>' +
    '<p class="note">Electrical Inspector — Aung Tay Zar</p></div>';

  try {
    const anns = pinnedFirst(await fetchAnnouncements("public"));
    const el = document.getElementById("home-ann");
    if (el) el.innerHTML = anns.length
      ? sortByCreatedDesc(anns).slice(0, 3).map(a => annBlock(a, true)).join("")
      : '<p class="empty">ကြေညာချက် မရှိသေးပါ။</p>';
  } catch (e) {
    const el = document.getElementById("home-ann");
    if (el) el.innerHTML = '<p class="empty">ကြေညာချက်များ ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
  try {
    const guides = pinnedFirst(await fetchGuidelines());
    const el = document.getElementById("home-guide");
    if (el) {
      const g = guides.find(x => x.pinned) || guides[0];
      el.innerHTML = g
        ? '<div class="ann"><span class="dt">📌</span><b class="t">' + esc(g.title) + "</b>" +
          '<p class="note">' + esc(g.body || "") + "</p>" +
          '<p class="note">တင်သူ: ' + AUTHOR_LABEL + "</p></div>"
        : '<p class="empty">လမ်းညွှန် မရှိသေးပါ။</p>';
    }
  } catch (e) {
    const el = document.getElementById("home-guide");
    if (el) el.innerHTML = '<p class="empty">လမ်းညွှန်များ ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
}

function viewSoftware(view) {
  /* APK downloads are intentionally NOT published on the portal yet
     (owner decision 2026-11-16). The APPS data + download logging stay
     in the code, dormant — re-enable by restoring the list rendering. */
  view.innerHTML =
    '<p><a class="linkish" href="#/">← ပင်မ</a></p>' +
    '<div class="card"><h2>🧰 စစ်ဆေးရေးသုံး Software များ</h2>' +
    '<p class="empty">Software များ မကြာမီ တင်ပေးပါမည်။</p></div>';
}

async function viewAnnouncements(view) {
  view.innerHTML = '<p><a class="linkish" href="#/">← ပင်မ</a></p>' +
    '<div class="card"><h2>📢 ကြေညာချက်များ (အများမြင်)</h2><div id="ann-list"><p class="note">⏳ ဖတ်နေသည်…</p></div></div>';
  try {
    const anns = pinnedFirst(await fetchAnnouncements("public"));
    const el = document.getElementById("ann-list");
    if (el) el.innerHTML = anns.length
      ? anns.map(a => annBlock(a, true)).join("")
      : '<p class="empty">ကြေညာချက် မရှိသေးပါ။</p>';
  } catch (e) {
    const el = document.getElementById("ann-list");
    if (el) el.innerHTML = '<p class="empty">ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
}

async function viewGuidelines(view) {
  view.innerHTML = '<p><a class="linkish" href="#/">← ပင်မ</a></p>' +
    '<div class="card"><h2>📌 အရေးကြီး လမ်းညွှန်များ</h2><div id="guide-list"><p class="note">⏳ ဖတ်နေသည်…</p></div>' +
    '<p class="note" style="margin-top:8px">လမ်းညွှန်များကို ' + AUTHOR_LABEL + ' က တင်ပေးပါသည်။</p></div>';
  try {
    const guides = pinnedFirst(await fetchGuidelines());
    const el = document.getElementById("guide-list");
    if (el) el.innerHTML = guides.length
      ? guides.map(g =>
          '<div class="book"><div class="bi">📌</div><div class="bt"><b>' + esc(g.title) + "</b>" +
          '<span class="note" style="white-space:pre-wrap">' + esc(g.body || "") + "</span></div></div>"
        ).join("")
      : '<p class="empty">လမ်းညွှန် မရှိသေးပါ။</p>';
  } catch (e) {
    const el = document.getElementById("guide-list");
    if (el) el.innerHTML = '<p class="empty">ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
}

async function viewAnnouncementDetail(view, id) {
  if (!id) { navTo("#/announcements"); return; }
  view.innerHTML = '<div class="card"><p class="note">⏳ ဖတ်နေသည်…</p></div>';
  let a = null;
  try {
    const snap = await getDoc(doc(db, "announcements", id));
    if (snap.exists()) a = Object.assign({ id: snap.id }, snap.data());
  } catch (e) { /* handled below */ }
  if (!a || !notExpired(a)) {
    view.innerHTML = '<div class="card"><h2>မတွေ့ပါ</h2><p class="note">ဤကြေညာချက် မရှိတော့ပါ သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီ။</p>' +
      '<p><a href="#/announcements">← ကြေညာချက်များ</a></p></div>';
    return;
  }
  if (a.audience === "internal" && !guardMember(view)) return;
  const back = a.audience === "internal" ? "#/internal" : "#/announcements";
  view.innerHTML =
    '<p><a class="linkish" href="' + back + '">← ကြေညာချက်များ</a></p>' +
    '<div class="card"><span class="dt note">' + fmtDate(a.createdAt) + "</span> " +
    (a.pinned ? '<span class="badge navy">📌 အရေးကြီး</span> ' : "") +
    (isNew(a.createdAt) ? '<span class="badge">အသစ်</span>' : "") +
    '<h2 style="margin-top:6px">' + esc(a.title) + "</h2>" +
    '<div class="ann"><p class="body">' + esc(a.body || "") + "</p>" +
    '<p class="note" style="margin-top:8px">တင်သူ: ' + AUTHOR_LABEL + "</p></div></div>" +
    '<div class="card"><h2>💬 မှတ်ချက်များ</h2><div id="comments"></div></div>';
  renderComments(document.getElementById("comments"), "announcement", id);
}

/* ================= AUTH ================= */

async function ensureProfile(user, extra) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    state.profile = snap.data();
    // Register form က data နဲ့ အတူ ခေါ်ရင် ကျန်နေတဲ့ အကွက်တွေ ဖြည့်ပေး (auth listener က အရင် ဖန်တီးသွားတဲ့ race ကို ပြင်)
    if (extra) {
      const fill = {};
      ["name", "phone", "position", "region"].forEach(k => {
        if (extra[k] && !String(state.profile[k] || "").trim()) fill[k] = extra[k];
      });
      if (Object.keys(fill).length) {
        try { await updateDoc(ref, fill); } catch (e) {}
        state.profile = Object.assign({}, state.profile, fill);
      }
    }
    return state.profile;
  }
  const profile = {
    name: (extra && extra.name) || user.displayName || "",
    email: user.email || "",
    phone: (extra && extra.phone) || "",
    position: (extra && extra.position) || "",
    region: (extra && extra.region) || "",
    role: isSuper() ? "admin" : "pending",
    disabled: false,
    createdAt: serverTimestamp()
  };
  await setDoc(ref, profile);
  state.profile = profile;
  return profile;
}

const notifiedUids = new Set();
function maybeNotifyNewRegistration(profile) {
  if (!profile || profile.role !== "pending" || isSuper()) return;
  const uid = state.user && state.user.uid;
  if (!uid || notifiedUids.has(uid)) return;
  notifiedUids.add(uid);
  notifyAdminsNewRegistration(profile);
}

// EmailJS: အဖွဲ့ဝင် အသစ် လျှောက်ထားရင် Admin Team email ဆီ noti ပို့ (fire-and-forget; fail ရင် registration မ ပိတ်)
function notifyAdminsNewRegistration(p) {
  try {
    const dash = v => (v && String(v).trim()) ? String(v).trim() : "—";
    const message =
      "EI Portal တွင် အဖွဲ့ဝင် အသစ် လျှောက်ထားပါသည်။\n\n" +
      "အမည်: " + dash(p.name) + "\n" +
      "Email: " + dash(p.email) + "\n" +
      "ဖုန်း: " + dash(p.phone) + "\n" +
      "ရာထူး: " + dash(p.position) + "\n" +
      "ရုံး/ဒေသ: " + dash(p.region) + "\n\n" +
      "ခွင့်ပြုရန်: https://ei-portal-417d4.web.app → Login → Admin → လျှောက်ထားဆဲ";
    fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          name: dash(p.name),
          email: dash(p.email),
          title: "အဖွဲ့ဝင် အသစ် လျှောက်ထား",
          message: message
        }
      })
    }).catch(function () {});
  } catch (e) { /* noti မရလည်း registration ဆက်သွား */ }
}

function afterAuthRoute() {
  if (isSuper() || isApprovedMember()) navTo("#/member");
  else navTo("#/waiting");
}

function viewLogin(view) {
  if (state.user) { afterAuthRoute(); return; }
  view.innerHTML =
    '<div class="card" style="margin-top:2px">' +
    '<h2 style="text-align:center">🔐 Login</h2>' +
    '<p style="text-align:center" class="note">ဌာနဝင် (အဖွဲ့ဝင်) များ အတွက်</p>' +
    '<div class="field"><label>Email</label><input id="li-email" type="email" autocomplete="email" placeholder="example@gmail.com"></div>' +
    '<div class="field"><label>Password</label><input id="li-pass" type="password" autocomplete="current-password" placeholder="••••••••"></div>' +
    '<button class="btn btn-navy" id="li-btn">ဝင်မည်</button>' +
    '<p style="text-align:center;margin:10px 0" class="note">— သို့မဟုတ် —</p>' +
    '<button class="btn btn-google" id="li-google">G&nbsp; Google နဲ့ ဝင်မယ်</button>' +
    '<p style="text-align:center;margin-top:12px" class="note">Password မေ့သွားပါက <span class="linkish" id="li-forgot">ဒီမှာ နှိပ်ပါ</span></p>' +
    msgHtml("li-msg") +
    "</div>" +

    '<div class="card"><h2>📝 အကောင့် အသစ် လျှောက်ရန် (Register)</h2>' +
    '<div class="field"><label>အမည် *</label><input id="rg-name" type="text" autocomplete="name" placeholder="မိမိအမည်"></div>' +
    '<div class="field"><label>Email *</label><input id="rg-email" type="email" autocomplete="email" placeholder="example@gmail.com"></div>' +
    '<div class="field"><label>Password အသစ် *</label><input id="rg-pass" type="password" autocomplete="new-password" placeholder="အနည်းဆုံး ၆ လုံး"></div>' +
    '<div class="field"><label>ဖုန်းနံပါတ်</label><input id="rg-phone" type="tel" autocomplete="tel" placeholder="09xxxxxxxxx"></div>' +
    '<div class="field"><label>ရာထူး</label><input id="rg-position" type="text" placeholder="ဥပမာ: လျှပ်စစ်စစ်ဆေးရေးမှူး"></div>' +
    '<div class="field"><label>ရုံး / တိုင်းဒေသ</label><input id="rg-region" type="text" placeholder="ဥပမာ: နေပြည်တော်"></div>' +
    '<button class="btn btn-line" id="rg-btn">လျှောက်ထားမည်</button>' +
    '<div class="waitbox">⏳ <b>အတည်ပြုချက် စောင့်ဆိုင်းဆဲ</b> — လျှောက်ထားပြီးပါက ' + AUTHOR_LABEL + ' ၏ ခွင့်ပြုချက် ရရှိပြီးမှသာ အဖွဲ့ဝင် အပိုင်းသို့ ဝင်နိုင်ပါမည်။</div>' +
    msgHtml("rg-msg") +
    "</div>" +
    '<p style="text-align:center;margin-top:14px"><a class="linkish" href="#/">← ပင်မသို့ ပြန်သွားရန်</a></p>';

  document.getElementById("li-btn").addEventListener("click", async () => {
    const email = document.getElementById("li-email").value.trim();
    const pass = document.getElementById("li-pass").value;
    if (!email || !pass) return showMsg("li-msg", "Email နှင့် Password ထည့်ပါ။", "err");
    const btn = document.getElementById("li-btn");
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      // onAuthStateChanged loads the profile, then we route:
      const check = setInterval(() => {
        if (state.authReady && state.user) { clearInterval(check); afterAuthRoute(); }
      }, 150);
      setTimeout(() => clearInterval(check), 6000);
    } catch (e) {
      btn.disabled = false;
      showMsg("li-msg", friendlyError(e), "err");
    }
  });

  document.getElementById("li-google").addEventListener("click", async () => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const prof = await ensureProfile(cred.user, {});
      maybeNotifyNewRegistration(prof);
      afterAuthRoute();
    } catch (e) {
      showMsg("li-msg", friendlyError(e), "err");
    }
  });

  document.getElementById("li-forgot").addEventListener("click", async () => {
    const email = document.getElementById("li-email").value.trim();
    if (!email) return showMsg("li-msg", "Password ပြန်သတ်မှတ်ရန် အပေါ်က Email အကွက်တွင် မိမိ Email အရင် ရိုက်ထည့်ပါ။", "info");
    try {
      await sendPasswordResetEmail(auth, email);
      showMsg("li-msg", "✔ Password ပြန်သတ်မှတ် link ကို " + email + " သို့ ပို့လိုက်ပါပြီ — Email ထဲမှ link ကို နှိပ်ပြီး Password အသစ် သတ်မှတ်ပါ။", "good");
    } catch (e) {
      showMsg("li-msg", friendlyError(e), "err");
    }
  });

  document.getElementById("rg-btn").addEventListener("click", async () => {
    const name = document.getElementById("rg-name").value.trim();
    const email = document.getElementById("rg-email").value.trim();
    const pass = document.getElementById("rg-pass").value;
    const phone = document.getElementById("rg-phone").value.trim();
    const position = document.getElementById("rg-position").value.trim();
    const region = document.getElementById("rg-region").value.trim();
    if (!name || !email || !pass) return showMsg("rg-msg", "အမည်၊ Email နှင့် Password (* အမှတ်ပါသောအကွက်) ဖြည့်ပါ။", "err");
    const btn = document.getElementById("rg-btn");
    btn.disabled = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      // Profile ကို ဒီ handler ကပဲ တိုက်ရိုက် ရေးတယ် (ensureProfile လမ်းကြောင်း မှာ form data ပျောက်တဲ့ ပြဿနာ ကြောင့်)
      const ref = doc(db, "users", cred.user.uid);
      const snap = await getDoc(ref);
      let prof;
      if (snap.exists()) {
        await updateDoc(ref, { name, phone, position, region });
        prof = Object.assign({}, snap.data(), { name, phone, position, region });
      } else {
        prof = { name, email, phone, position, region, role: "pending", disabled: false, createdAt: serverTimestamp() };
        await setDoc(ref, prof);
      }
      // ပြန်ဖတ် အတည်ပြု — မရောက်သေးရင် တစ်ကြိမ် ထပ်ဖြည့်
      const chk = await getDoc(ref);
      if (chk.exists() && !String(chk.data().name || "").trim()) {
        await updateDoc(ref, { name, phone, position, region });
        prof = Object.assign({}, chk.data(), { name, phone, position, region });
      } else if (chk.exists()) {
        prof = chk.data();
      }
      state.profile = prof;
      maybeNotifyNewRegistration(prof);
      navTo("#/waiting");
    } catch (e) {
      btn.disabled = false;
      showMsg("rg-msg", friendlyError(e), "err");
    }
  });
}

function viewWaiting(view) {
  if (!state.user) { navTo("#/login"); return; }
  if (isApprovedMember()) { navTo("#/member"); return; }
  const p = state.profile || {};
  let title = "⏳ အတည်ပြုချက် စောင့်ဆိုင်းဆဲ";
  let body = AUTHOR_LABEL + " ၏ ခွင့်ပြုချက် ရရှိပြီးမှသာ အဖွဲ့ဝင် အပိုင်းသို့ ဝင်နိုင်ပါမည်။ ခွင့်ပြုပြီးပါက နောက်တစ်ခါ Login ဝင်ရုံနှင့် အဖွဲ့ဝင် အပိုင်းသို့ တန်းဝင်နိုင်ပါမည်။";
  if (p.role === "rejected") {
    title = "🚫 လျှောက်ထားချက် မအောင်မြင်ပါ";
    body = "ဤအကောင့်ကို ခွင့်ပြုချက် မရရှိပါ။ အသေးစိတ် သိလိုပါက " + AUTHOR_LABEL + " သို့ ဆက်သွယ်ပါ။";
  } else if (p.disabled) {
    title = "🚫 အကောင့် ပိတ်ထားသည်";
    body = "ဤအကောင့်ကို ခေတ္တ ပိတ်ထားပါသည်။ အသေးစိတ် သိလိုပါက " + AUTHOR_LABEL + " သို့ ဆက်သွယ်ပါ။";
  }
  view.innerHTML =
    '<div class="card"><h2>' + title + "</h2>" +
    '<p><b>' + esc(p.name || state.user.displayName || "") + "</b> (" + esc(state.user.email || "") + ")</p>" +
    '<p class="note" style="margin-top:6px">' + body + "</p>" +
    '<div class="waitbox">အကောင့် အခြေအနေ: <b>' +
    (p.role === "rejected" ? "ပယ်ချထား" : p.disabled ? "ပိတ်ထား" : "စောင့်ဆိုင်းဆဲ") + "</b></div>" +
    '<p style="margin-top:12px"><button class="btn btn-line" id="w-logout">🚪 Logout (ထွက်မည်)</button></p></div>';
  document.getElementById("w-logout").addEventListener("click", async () => {
    await signOut(auth);
    navTo("#/");
  });
}

/* ================= MEMBER ZONE ================= */

function viewMemberHome(view) {
  if (!guardMember(view)) return;
  const name = (state.profile && state.profile.name) || state.user.displayName || "";
  view.innerHTML =
    '<header class="site small"><img src="assets/EI-logo.png" alt="EI logo"><div><h1>မင်္ဂလာပါ, ' +
    esc(name) + ' 👋</h1><p>အဖွဲ့ဝင် အပိုင်း — 🔒 အဖွဲ့ဝင်များသာ</p></div></header>' +
    '<div class="menu">' +
    '<div class="card" data-go="#/library"><div class="mi">📚</div><b>စာအုပ် / လုပ်ထုံး</b><span class="note">Library</span></div>' +
    '<div class="card" data-go="#/internal"><div class="mi">📢</div><b>ဌာနတွင်း ကြေညာချက်</b><span class="note" id="m-ann-note">ကြည့်ရန်</span></div>' +
    '<div class="card" data-go="#/directory"><div class="mi">👥</div><b>အဖွဲ့ဝင်စာရင်း</b><span class="note">ဆက်သွယ်ရန်</span></div>' +
    '<div class="card" data-go="#/account"><div class="mi">👤</div><b>ကျွန်ုပ် Account</b><span class="note">အမည်/Password ပြင်</span></div>' +
    "</div>" +
    '<div style="margin-top:14px"><button class="btn btn-line" id="m-logout">🚪 Logout (ထွက်မည်)</button></div>';
  view.querySelectorAll("[data-go]").forEach(c =>
    c.addEventListener("click", () => navTo(c.getAttribute("data-go"))));
  document.getElementById("m-logout").addEventListener("click", async () => {
    await signOut(auth);
    navTo("#/");
  });
  fetchAnnouncements("internal").then(list => {
    const el = document.getElementById("m-ann-note");
    if (el) el.textContent = "အသစ် " + myNum(list.filter(a => isNew(a.createdAt)).length) + " ခု";
  }).catch(() => {});
}

/* ----- Library ----- */
let libraryCache = [];
let libraryCat = "အားလုံး";
let librarySearch = "";
let clOldFileUrl = ""; /* admin library form: fileUrl of the item being edited */

async function viewLibrary(view) {
  if (!guardMember(view)) return;
  view.innerHTML =
    '<p><a class="linkish" href="#/member">← အဖွဲ့ဝင်ပင်မ</a> &nbsp;<span class="badge navy">🔒 အဖွဲ့ဝင်များသာ</span></p>' +
    '<div class="secttl">📚 စာအုပ် နှင့် လုပ်ထုံးများ</div>' +
    '<input class="searchbox" id="lib-q" type="search" placeholder="🔎 ရှာရန် — စာအုပ်အမည် ရိုက်ပါ">' +
    '<div class="chips" id="lib-chips"></div>' +
    '<div class="card"><div id="lib-list"><p class="note">⏳ ဖတ်နေသည်…</p></div></div>' +
    '<p class="note" style="margin-top:10px">ဖိုင်များကို အဖွဲ့ဝင်များသာ download လုပ်နိုင်မည် — link တိုက်ရိုက် ခေါ်လျှင် မရပါ။</p>';
  const chipsEl = document.getElementById("lib-chips");
  const cats = ["အားလုံး"].concat(LIBRARY_CATEGORIES);
  chipsEl.innerHTML = cats.map(c =>
    '<span data-cat="' + esc(c) + '"' + (c === libraryCat ? ' class="on"' : "") + ">" + esc(c) + "</span>").join("");
  chipsEl.querySelectorAll("[data-cat]").forEach(ch =>
    ch.addEventListener("click", () => { libraryCat = ch.getAttribute("data-cat"); viewLibrary(view); }));
  const q = document.getElementById("lib-q");
  q.value = librarySearch;
  q.addEventListener("input", () => { librarySearch = q.value; drawLibraryList(); });
  try {
    const snap = await getDocs(collection(db, "library"));
    libraryCache = [];
    snap.forEach(d => libraryCache.push(Object.assign({ id: d.id }, d.data())));
    libraryCache = sortByCreatedDesc(libraryCache);
  } catch (e) {
    const el = document.getElementById("lib-list");
    if (el) el.innerHTML = '<p class="empty">ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
    return;
  }
  drawLibraryList();
}
function drawLibraryList() {
  const el = document.getElementById("lib-list");
  if (!el) return;
  const q = librarySearch.trim().toLowerCase();
  const list = libraryCache.filter(it =>
    (libraryCat === "အားလုံး" || it.category === libraryCat) &&
    (!q || String(it.title || "").toLowerCase().includes(q) || String(it.note || "").toLowerCase().includes(q)));
  el.innerHTML = list.length ? list.map(it =>
    '<div class="book"><div class="bi">📕</div><div class="bt">' +
    '<b><a href="#/library-item/' + it.id + '">' + esc(it.title) + "</a></b>" +
    '<span class="note">အမျိုးအစား: ' + esc(it.category || "အခြား") +
    (it.sizeBytes ? " · " + fmtSize(it.sizeBytes) : "") +
    (it.note ? "<br>" + esc(it.note) : "") + "</span></div>" +
    '<button class="dl" data-lib-dl="' + it.id + '">⬇</button></div>'
  ).join("") : '<p class="empty">မတွေ့ပါ။</p>';
  el.querySelectorAll("[data-lib-dl]").forEach(b =>
    b.addEventListener("click", () => downloadLibraryItem(b.getAttribute("data-lib-dl"), b)));
}
/* ----- Stored-file helpers (Firestore chunk storage, no Storage bucket) ----- */
function bytesToB64(bytes) {
  let out = "";
  const STEP = 32768;
  for (let i = 0; i < bytes.length; i += STEP) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(out);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function uploadLibraryFile(file, onProgress) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const fileId = doc(collection(db, "libraryFiles")).id;
  const nChunks = Math.max(1, Math.ceil(buf.length / CHUNK_RAW_BYTES));
  await setDoc(doc(db, "libraryFiles", fileId), {
    name: file.name, size: buf.length,
    mime: file.type || "application/pdf",
    chunks: nChunks, createdBy: state.user.uid, createdAt: serverTimestamp()
  });
  for (let start = 0; start < nChunks; start += 200) {
    const batch = writeBatch(db);
    const end = Math.min(nChunks, start + 200);
    for (let i = start; i < end; i++) {
      const slice = buf.subarray(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES);
      batch.set(doc(db, "libraryFiles", fileId, "chunks", String(i)), { d: bytesToB64(slice) });
    }
    await batch.commit();
    if (onProgress) onProgress(end / nChunks);
  }
  return fileId;
}
async function fetchStoredFileBlob(fileId) {
  const metaSnap = await getDoc(doc(db, "libraryFiles", fileId));
  if (!metaSnap.exists()) throw new Error("ဖိုင် မတွေ့ပါ။");
  const meta = metaSnap.data();
  const parts = [];
  let total = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const cs = await getDoc(doc(db, "libraryFiles", fileId, "chunks", String(i)));
    if (!cs.exists()) throw new Error("ဖိုင် အပိုင်း ပျောက်နေသည်။");
    const b = b64ToBytes(cs.data().d);
    parts.push(b); total += b.length;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return { blob: new Blob([all], { type: meta.mime || "application/pdf" }), name: meta.name || "file.pdf" };
}
async function deleteStoredFile(fileId) {
  try {
    const snap = await getDocs(collection(db, "libraryFiles", fileId, "chunks"));
    const docs = [];
    snap.forEach(d => docs.push(d.ref));
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      docs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit();
    }
    await deleteDoc(doc(db, "libraryFiles", fileId));
  } catch (e) { /* best effort — catalogue entry is already gone */ }
}

async function downloadLibraryItem(id, btn) {
  const it = libraryCache.find(x => x.id === id);
  if (!it || !it.fileUrl) return;
  logDownload({ kind: "library", name: it.title, version: "" });
  if (it.fileUrl.indexOf("store:") === 0) {
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "⏳"; }
    try {
      const f = await fetchStoredFileBlob(it.fileUrl.slice(6));
      const url = URL.createObjectURL(f.blob);
      const a = document.createElement("a");
      a.href = url; a.download = it.fileName || f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (btn) btn.textContent = "✖";
      setTimeout(() => { if (btn) btn.textContent = old || "⬇"; }, 2500);
    }
    if (btn) { btn.disabled = false; if (btn.textContent === "⏳") btn.textContent = old || "⬇"; }
    return;
  }
  window.open(it.fileUrl, "_blank");
}

async function viewLibraryItem(view, id) {
  if (!guardMember(view)) return;
  if (!id) { navTo("#/library"); return; }
  view.innerHTML = '<div class="card"><p class="note">⏳ ဖတ်နေသည်…</p></div>';
  let it = null;
  try {
    const snap = await getDoc(doc(db, "library", id));
    if (snap.exists()) it = Object.assign({ id: snap.id }, snap.data());
  } catch (e) { /* below */ }
  if (!it) {
    view.innerHTML = '<div class="card"><h2>မတွေ့ပါ</h2><p><a href="#/library">← Library သို့</a></p></div>';
    return;
  }
  libraryCache = [it];
  view.innerHTML =
    '<p><a class="linkish" href="#/library">← Library</a> &nbsp;<span class="badge navy">🔒 အဖွဲ့ဝင်များသာ</span></p>' +
    '<div class="card"><div class="book"><div class="bi">📕</div><div class="bt"><b>' + esc(it.title) + "</b>" +
    '<span class="note">အမျိုးအစား: ' + esc(it.category || "အခြား") +
    (it.sizeBytes ? " · " + fmtSize(it.sizeBytes) : "") +
    "<br>တင်သူ: " + AUTHOR_LABEL + " · " + fmtDate(it.createdAt) +
    (it.note ? "<br>" + esc(it.note) : "") + "</span></div></div>" +
    '<button class="btn btn-navy" id="libitem-dl">⬇ Download</button>' +
    '<div id="libitem-msg"></div></div>' +
    '<div class="card"><h2>💬 မှတ်ချက်များ</h2><div id="comments"></div></div>';
  document.getElementById("libitem-dl").addEventListener("click", ev => downloadLibraryItem(id, ev.currentTarget));
  renderComments(document.getElementById("comments"), "library", id);
}

/* ----- Comments (shared: announcements + library) ----- */
async function renderComments(container, targetType, targetId) {
  if (!container) return;
  if (!isApprovedMember()) {
    container.innerHTML = '<p class="note">မှတ်ချက် ဖတ်/ရေးရန် အဖွဲ့ဝင် အဖြစ် <a href="#/login">Login</a> ဝင်ပါ။</p>';
    return;
  }
  container.innerHTML = '<p class="note">⏳ ဖတ်နေသည်…</p>';
  let list = [];
  try {
    const snap = await getDocs(query(collection(db, "comments"),
      where("targetType", "==", targetType), where("targetId", "==", targetId)));
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    list = list.slice().sort((a, b) => {
      const ta = toDate(a.createdAt), tb = toDate(b.createdAt);
      return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
    });
  } catch (e) {
    container.innerHTML = '<p class="empty">မှတ်ချက်များ ဖတ်၍ မရပါ။</p>';
    return;
  }
  const staff = isStaff();
  const mine = state.user.uid;
  const rows = list.filter(c => staff || !c.hidden).map(c =>
    '<div class="comment' + (c.hidden ? " hidden-c" : "") + '">' +
    '<span class="cn">' + esc(c.authorName || "အဖွဲ့ဝင်") + "</span>" +
    '<span class="ct">' + fmtDateTime(c.createdAt) + "</span>" +
    (c.hidden ? ' <span class="badge grey">ဝှက်ထား</span>' : "") +
    '<div class="cb">' + esc(c.text || "") + "</div>" +
    ((staff || c.uid === mine)
      ? '<div class="cops">' +
        (staff ? '<span class="linkish" data-c-toggle="' + c.id + '">' + (c.hidden ? "ပြန်ပြ" : "ဝှက်") + "</span> · " : "") +
        '<span class="linkish" data-c-del="' + c.id + '">ဖျက်</span></div>'
      : "") +
    "</div>"
  ).join("");
  container.innerHTML =
    (rows || '<p class="empty">မှတ်ချက် မရှိသေးပါ။</p>') +
    '<div class="field" style="margin-top:12px"><label>မှတ်ချက် ရေးရန်</label>' +
    '<textarea id="c-text" placeholder="မိမိ ထင်မြင်ချက် ရေးပါ"></textarea></div>' +
    '<button class="btn btn-navy btn-sm" id="c-send">ပို့မည်</button>' + msgHtml("c-msg");
  container.querySelectorAll("[data-c-del]").forEach(el =>
    el.addEventListener("click", async () => {
      try { await deleteDoc(doc(db, "comments", el.getAttribute("data-c-del"))); renderComments(container, targetType, targetId); }
      catch (e) { showMsg("c-msg", friendlyError(e), "err"); }
    }));
  container.querySelectorAll("[data-c-toggle]").forEach(el =>
    el.addEventListener("click", async () => {
      const cid = el.getAttribute("data-c-toggle");
      const c = list.find(x => x.id === cid);
      try { await updateDoc(doc(db, "comments", cid), { hidden: !(c && c.hidden) }); renderComments(container, targetType, targetId); }
      catch (e) { showMsg("c-msg", friendlyError(e), "err"); }
    }));
  document.getElementById("c-send").addEventListener("click", async () => {
    const text = document.getElementById("c-text").value.trim();
    if (!text) return showMsg("c-msg", "မှတ်ချက် အရင် ရေးပါ။", "err");
    try {
      await addDoc(collection(db, "comments"), {
        targetType, targetId,
        uid: state.user.uid,
        authorName: (state.profile && state.profile.name) || state.user.displayName || "အဖွဲ့ဝင်",
        text, hidden: false, createdAt: serverTimestamp()
      });
      renderComments(container, targetType, targetId);
    } catch (e) {
      showMsg("c-msg", friendlyError(e), "err");
    }
  });
}

/* ----- Internal announcements ----- */
async function viewInternal(view) {
  if (!guardMember(view)) return;
  view.innerHTML =
    '<p><a class="linkish" href="#/member">← အဖွဲ့ဝင်ပင်မ</a> &nbsp;<span class="badge navy">🔒 အဖွဲ့ဝင်များသာ</span></p>' +
    '<div class="card"><h2>📢 ဌာနတွင်း ကြေညာချက်များ</h2><div id="int-list"><p class="note">⏳ ဖတ်နေသည်…</p></div></div>';
  try {
    const anns = pinnedFirst(await fetchAnnouncements("internal"));
    const el = document.getElementById("int-list");
    if (el) el.innerHTML = anns.length
      ? anns.map(a => annBlock(a, true)).join("")
      : '<p class="empty">ကြေညာချက် မရှိသေးပါ။</p>';
  } catch (e) {
    const el = document.getElementById("int-list");
    if (el) el.innerHTML = '<p class="empty">ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
}

/* ----- Member directory (no role badges — everyone shown as ordinary member) ----- */
async function viewDirectory(view) {
  if (!guardMember(view)) return;
  view.innerHTML =
    '<p><a class="linkish" href="#/member">← အဖွဲ့ဝင်ပင်မ</a> &nbsp;<span class="badge navy">🔒 အဖွဲ့ဝင်များသာ</span></p>' +
    '<div class="card"><h2>👥 အဖွဲ့ဝင်စာရင်း</h2><div id="dir-list"><p class="note">⏳ ဖတ်နေသည်…</p></div></div>';
  try {
    const snap = await getDocs(collection(db, "users"));
    const list = [];
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    const members = list
      .filter(u => ["member", "deputy", "admin"].includes(u.role) && !u.disabled)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const el = document.getElementById("dir-list");
    if (el) el.innerHTML = members.length ? members.map(u =>
      '<div class="rowline"><div class="who"><b>' + esc(u.name || "—") + "</b>" +
      '<span class="note">' + esc(u.position || "") +
      (u.region ? " · " + esc(u.region) : "") +
      (u.phone ? "<br>📞 " + esc(u.phone) : "") + "</span></div></div>"
    ).join("") : '<p class="empty">အဖွဲ့ဝင် မရှိသေးပါ။</p>';
  } catch (e) {
    const el = document.getElementById("dir-list");
    if (el) el.innerHTML = '<p class="empty">ဖတ်၍ မရပါ — နောက်မှ ထပ်ကြိုးစားပါ။</p>';
  }
}

/* ----- My account ----- */
function viewAccount(view) {
  if (!state.user) { navTo("#/login"); return; }
  if (!isApprovedMember() && !isSuper()) { navTo("#/waiting"); return; }
  const p = state.profile || {};
  view.innerHTML =
    '<p><a class="linkish" href="#/member">← အဖွဲ့ဝင်ပင်မ</a></p>' +
    '<div class="card"><h2>👤 ကျွန်ုပ် Account</h2>' +
    '<p class="note">Email: <b>' + esc(state.user.email || "") + "</b> (Email ပြောင်း၍ မရပါ)</p>" +
    '<div class="field" style="margin-top:10px"><label>အမည်</label><input id="ac-name" type="text" value="' + esc(p.name || "") + '"></div>' +
    '<div class="field"><label>ဖုန်းနံပါတ်</label><input id="ac-phone" type="tel" value="' + esc(p.phone || "") + '"></div>' +
    '<div class="field"><label>ရာထူး</label><input id="ac-position" type="text" value="' + esc(p.position || "") + '"></div>' +
    '<div class="field"><label>ရုံး / တိုင်းဒေသ</label><input id="ac-region" type="text" value="' + esc(p.region || "") + '"></div>' +
    '<button class="btn btn-navy" id="ac-save">သိမ်းမည်</button>' + msgHtml("ac-msg") + "</div>" +
    '<div class="card"><h2>🔑 Password ပြောင်းရန်</h2>' +
    '<div class="field"><label>Password အသစ်</label><input id="ac-pass" type="password" autocomplete="new-password" placeholder="အနည်းဆုံး ၆ လုံး"></div>' +
    '<button class="btn btn-line" id="ac-passbtn">ပြောင်းမည်</button>' + msgHtml("acp-msg") +
    '<p class="note" style="margin-top:8px">Google နဲ့ ဝင်ထားသူများမှာ Password ပြောင်းရန် မလိုပါ။</p></div>' +
    '<div style="margin-top:14px"><button class="btn btn-line" id="ac-logout">🚪 Logout (ထွက်မည်)</button></div>';
  document.getElementById("ac-save").addEventListener("click", async () => {
    try {
      const data = {
        name: document.getElementById("ac-name").value.trim(),
        phone: document.getElementById("ac-phone").value.trim(),
        position: document.getElementById("ac-position").value.trim(),
        region: document.getElementById("ac-region").value.trim()
      };
      await updateDoc(doc(db, "users", state.user.uid), data);
      state.profile = Object.assign({}, state.profile, data);
      showMsg("ac-msg", "✔ သိမ်းပြီးပါပြီ။", "good");
    } catch (e) { showMsg("ac-msg", friendlyError(e), "err"); }
  });
  document.getElementById("ac-passbtn").addEventListener("click", async () => {
    const pw = document.getElementById("ac-pass").value;
    if (pw.length < 6) return showMsg("acp-msg", "Password အနည်းဆုံး ၆ လုံး ထားပါ။", "err");
    try {
      await updatePassword(state.user, pw);
      showMsg("acp-msg", "✔ Password ပြောင်းပြီးပါပြီ။", "good");
    } catch (e) { showMsg("acp-msg", friendlyError(e), "err"); }
  });
  document.getElementById("ac-logout").addEventListener("click", async () => {
    await signOut(auth);
    navTo("#/");
  });
}

/* ================= ADMIN ZONE (deputy + admin; roles section: super-admin only) ================= */

async function fetchAllUsers() {
  const snap = await getDocs(collection(db, "users"));
  const list = [];
  snap.forEach(d => list.push(Object.assign({ uid: d.id }, d.data())));
  return list;
}
function userLine(u, actsHtml) {
  return '<div class="rowline"><div class="who"><b>' + esc(u.name || "—") + "</b>" +
    '<span class="note">' + esc(u.email || "") +
    (u.phone ? " · " + esc(u.phone) : "") +
    (u.position ? "<br>" + esc(u.position) : "") +
    (u.region ? " · " + esc(u.region) : "") +
    "<br>လျှောက်ရက်: " + fmtDate(u.createdAt) + "</span></div>" +
    '<div class="acts">' + actsHtml + "</div></div>";
}

async function viewAdmin(view, tab) {
  if (!guardStaff(view)) return;
  const tabs = [
    ["approvals", "👥 လျှောက်ထားဆဲ"],
    ["members", "📋 အဖွဲ့ဝင်များ"],
    ["content", "📤 အကြောင်းအရာ တင်/ပြင်"],
    ["downloads", "⬇ Download မှတ်တမ်း"]
  ];
  if (isSuper()) tabs.push(["roles", "🔑 Role စီမံ (Admin သာ)"]);
  if (!tabs.some(t => t[0] === tab)) tab = "approvals";
  view.innerHTML =
    '<p><span class="badge navy">🛠 ' + AUTHOR_LABEL + ' သာ</span></p>' +
    '<div class="tabs">' + tabs.map(t =>
      '<button data-tab="' + t[0] + '"' + (t[0] === tab ? ' class="on"' : "") + ">" + t[1] + "</button>").join("") + "</div>" +
    '<div id="admin-body"><div class="card"><p class="note">⏳ ဖတ်နေသည်…</p></div></div>';
  view.querySelectorAll("[data-tab]").forEach(b =>
    b.addEventListener("click", () => navTo("#/admin/" + b.getAttribute("data-tab"))));
  const body = document.getElementById("admin-body");
  if (tab === "approvals") return adminApprovals(body);
  if (tab === "members") return adminMembers(body);
  if (tab === "content") return adminContent(body);
  if (tab === "downloads") return adminDownloads(body);
  if (tab === "roles") return adminRoles(body);
}

async function adminApprovals(body) {
  let list = [];
  try {
    const snap = await getDocs(query(collection(db, "users"), where("role", "==", "pending")));
    snap.forEach(d => list.push(Object.assign({ uid: d.id }, d.data())));
    list = sortByCreatedDesc(list);
  } catch (e) {
    body.innerHTML = '<div class="card"><p class="empty">ဖတ်၍ မရပါ — ' + esc(friendlyError(e)) + "</p></div>";
    return;
  }
  body.innerHTML = '<div class="card"><h2>👥 လျှောက်ထားဆဲ (' + myNum(list.length) + ')</h2>' +
    (list.length ? list.map(u => userLine(u,
      '<button class="ok" data-approve="' + u.uid + '">✓ Approve</button>' +
      '<button class="no" data-reject="' + u.uid + '">✗ Reject</button>')).join("")
      : '<p class="empty">လျှောက်ထားဆဲ မရှိပါ။</p>') + msgHtml("ap-msg") + "</div>";
  body.querySelectorAll("[data-approve]").forEach(b =>
    b.addEventListener("click", async () => {
      try { await updateDoc(doc(db, "users", b.getAttribute("data-approve")), { role: "member", disabled: false }); adminApprovals(body); }
      catch (e) { showMsg("ap-msg", friendlyError(e), "err"); }
    }));
  body.querySelectorAll("[data-reject]").forEach(b =>
    b.addEventListener("click", async () => {
      try { await updateDoc(doc(db, "users", b.getAttribute("data-reject")), { role: "rejected" }); adminApprovals(body); }
      catch (e) { showMsg("ap-msg", friendlyError(e), "err"); }
    }));
}

async function adminMembers(body) {
  let list = [];
  try {
    list = (await fetchAllUsers()).filter(u => u.role !== "pending")
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  } catch (e) {
    body.innerHTML = '<div class="card"><p class="empty">ဖတ်၍ မရပါ — ' + esc(friendlyError(e)) + "</p></div>";
    return;
  }
  const roleName = { member: "အဖွဲ့ဝင်", deputy: "Admin Team", admin: "Admin Team", rejected: "ပယ်ချထား" };
  body.innerHTML = '<div class="card"><h2>📋 အဖွဲ့ဝင်စာရင်း (' + myNum(list.length) + ')</h2>' +
    (list.length ? list.map(u => {
      const canToggle = isSuper() || ["member", "rejected"].includes(u.role);
      const acts = '<span class="note">' + esc(roleName[u.role] || u.role || "") + (u.disabled ? " · ပိတ်ထား" : "") + "</span>" +
        (canToggle ? '<button class="toggle" data-toggle="' + u.uid + '" data-cur="' + (u.disabled ? "1" : "0") + '">' +
          (u.disabled ? "ပြန်ဖွင့်" : "ပိတ်") + "</button>" : "");
      return userLine(u, acts);
    }).join("") : '<p class="empty">အဖွဲ့ဝင် မရှိသေးပါ။</p>') + msgHtml("mb-msg") + "</div>";
  body.querySelectorAll("[data-toggle]").forEach(b =>
    b.addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "users", b.getAttribute("data-toggle")),
          { disabled: b.getAttribute("data-cur") !== "1" });
        adminMembers(body);
      } catch (e) { showMsg("mb-msg", friendlyError(e), "err"); }
    }));
}

function expiryInputToTs(val) {
  if (!val) return null;
  const d = new Date(val + "T23:59:59");
  return isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
}
function tsToDateInput(v) {
  const d = toDate(v);
  if (!d) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function adminContent(body) {
  body.innerHTML =
    '<div class="card"><h2>📢 ကြေညာချက် တင် / ပြင်</h2>' +
    '<input type="hidden" id="ca-id">' +
    '<div class="field"><label>ခေါင်းစဉ်</label><input id="ca-title" type="text"></div>' +
    '<div class="field"><label>စာကိုယ်</label><textarea id="ca-body"></textarea></div>' +
    '<div class="field"><label>မြင်ရမည့်သူ</label><select id="ca-aud">' +
    '<option value="public">အများမြင်</option><option value="internal">အဖွဲ့ဝင်များသာ (ဌာနတွင်း)</option></select></div>' +
    '<label class="checkline"><input type="checkbox" id="ca-pin"> 📌 အရေးကြီး အဖြစ် အမြဲ အပေါ်မှာ ထား</label>' +
    '<div class="field"><label>သက်တမ်းကုန်ရက် (မထည့်လည်း ရ — ကုန်ရင် အလိုလို ဝှက်)</label><input id="ca-exp" type="date"></div>' +
    '<button class="btn btn-navy" id="ca-save">သိမ်းမည်</button> ' +
    '<button class="btn btn-line btn-sm" id="ca-clear">အသစ် ပြန်စရန်</button>' + msgHtml("ca-msg") +
    '<h3>တင်ထားသော ကြေညာချက်များ</h3><div id="ca-list"><p class="note">⏳</p></div></div>' +

    '<div class="card"><h2>📌 လမ်းညွှန် တင် / ပြင်</h2>' +
    '<input type="hidden" id="cg-id">' +
    '<div class="field"><label>ခေါင်းစဉ်</label><input id="cg-title" type="text"></div>' +
    '<div class="field"><label>စာကိုယ်</label><textarea id="cg-body"></textarea></div>' +
    '<label class="checkline"><input type="checkbox" id="cg-pin"> 📌 အရေးကြီး (ပင်မစာမျက်နှာတွင် ပြ)</label>' +
    '<div class="field"><label>သက်တမ်းကုန်ရက် (မထည့်လည်း ရ)</label><input id="cg-exp" type="date"></div>' +
    '<button class="btn btn-navy" id="cg-save">သိမ်းမည်</button> ' +
    '<button class="btn btn-line btn-sm" id="cg-clear">အသစ် ပြန်စရန်</button>' + msgHtml("cg-msg") +
    '<h3>တင်ထားသော လမ်းညွှန်များ</h3><div id="cg-list"><p class="note">⏳</p></div></div>' +

    '<div class="card"><h2>📚 စာအုပ် တင် / ပြင်</h2>' +
    '<input type="hidden" id="cl-id">' +
    '<div class="field"><label>အမည်</label><input id="cl-title" type="text"></div>' +
    '<div class="field"><label>အမျိုးအစား</label><select id="cl-cat">' +
    LIBRARY_CATEGORIES.map(c => '<option value="' + esc(c) + '">' + esc(c) + "</option>").join("") + "</select></div>" +
    '<div class="field"><label>မှတ်စုတို</label><input id="cl-note" type="text"></div>' +
    '<div class="field"><label>ဖိုင် တိုက်ရိုက်တင် (PDF — အများဆုံး 100 MB)</label><input id="cl-file" type="file" accept="application/pdf,.pdf"></div>' +
    '<p class="note" id="cl-curfile"></p>' +
    '<div class="field"><label>သို့မဟုတ် ဖိုင် link (URL)</label><input id="cl-fileurl" type="text" placeholder="/library-files/example.pdf"></div>' +
    '<p class="note">ဖိုင် ရွေးထားပါက တိုက်ရိုက်တင် စနစ်ဖြင့် သိမ်းမည်။ ဖိုင် မရွေးဘဲ link ထည့်လည်း ရသည်။</p>' +
    '<p class="note" id="cl-progress"></p>' +
    '<button class="btn btn-navy" id="cl-save">သိမ်းမည်</button> ' +
    '<button class="btn btn-line btn-sm" id="cl-clear">အသစ် ပြန်စရန်</button>' + msgHtml("cl-msg") +
    '<h3>တင်ထားသော စာအုပ်များ</h3><div id="cl-list"><p class="note">⏳</p></div></div>';

  const $ = id => document.getElementById(id);
  /* --- announcements --- */
  async function drawAnnList() {
    const snap = await getDocs(collection(db, "announcements"));
    const list = [];
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    $("ca-list").innerHTML = sortByCreatedDesc(list).map(a =>
      '<div class="rowline"><div class="who"><b>' + esc(a.title) + "</b>" +
      '<span class="note">' + (a.audience === "internal" ? "ဌာနတွင်း" : "အများမြင်") + " · " + fmtDate(a.createdAt) +
      (a.pinned ? " · 📌" : "") + (toDate(a.expiresAt) ? " · ကုန်ရက် " + fmtDate(a.expiresAt) : "") + "</span></div>" +
      '<div class="acts"><button class="toggle" data-ca-edit="' + a.id + '">ပြင်</button>' +
      '<button class="toggle" data-ca-del="' + a.id + '">ဖျက်</button></div></div>').join("") ||
      '<p class="empty">မရှိသေးပါ။</p>';
    $("ca-list").querySelectorAll("[data-ca-edit]").forEach(b =>
      b.addEventListener("click", () => {
        const a = list.find(x => x.id === b.getAttribute("data-ca-edit"));
        if (!a) return;
        $("ca-id").value = a.id; $("ca-title").value = a.title || ""; $("ca-body").value = a.body || "";
        $("ca-aud").value = a.audience || "public"; $("ca-pin").checked = !!a.pinned;
        $("ca-exp").value = tsToDateInput(a.expiresAt);
        window.scrollTo(0, 0);
      }));
    $("ca-list").querySelectorAll("[data-ca-del]").forEach(b =>
      b.addEventListener("click", async () => {
        try { await deleteDoc(doc(db, "announcements", b.getAttribute("data-ca-del"))); drawAnnList(); }
        catch (e) { showMsg("ca-msg", friendlyError(e), "err"); }
      }));
  }
  $("ca-clear").addEventListener("click", () => {
    $("ca-id").value = ""; $("ca-title").value = ""; $("ca-body").value = "";
    $("ca-pin").checked = false; $("ca-exp").value = "";
  });
  $("ca-save").addEventListener("click", async () => {
    const title = $("ca-title").value.trim();
    if (!title) return showMsg("ca-msg", "ခေါင်းစဉ် ထည့်ပါ။", "err");
    const data = {
      title, body: $("ca-body").value.trim(), audience: $("ca-aud").value,
      pinned: $("ca-pin").checked, expiresAt: expiryInputToTs($("ca-exp").value),
      authorLabel: AUTHOR_LABEL, updatedAt: serverTimestamp()
    };
    try {
      if ($("ca-id").value) await updateDoc(doc(db, "announcements", $("ca-id").value), data);
      else await addDoc(collection(db, "announcements"),
        Object.assign(data, { createdBy: state.user.uid, createdAt: serverTimestamp() }));
      showMsg("ca-msg", "✔ သိမ်းပြီးပါပြီ။", "good");
      $("ca-clear").click(); drawAnnList();
    } catch (e) { showMsg("ca-msg", friendlyError(e), "err"); }
  });
  /* --- guidelines --- */
  async function drawGuideList() {
    const snap = await getDocs(collection(db, "guidelines"));
    const list = [];
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    $("cg-list").innerHTML = sortByCreatedDesc(list).map(g =>
      '<div class="rowline"><div class="who"><b>' + esc(g.title) + "</b>" +
      '<span class="note">' + fmtDate(g.createdAt) + (g.pinned ? " · 📌" : "") +
      (toDate(g.expiresAt) ? " · ကုန်ရက် " + fmtDate(g.expiresAt) : "") + "</span></div>" +
      '<div class="acts"><button class="toggle" data-cg-edit="' + g.id + '">ပြင်</button>' +
      '<button class="toggle" data-cg-del="' + g.id + '">ဖျက်</button></div></div>').join("") ||
      '<p class="empty">မရှိသေးပါ။</p>';
    $("cg-list").querySelectorAll("[data-cg-edit]").forEach(b =>
      b.addEventListener("click", () => {
        const g = list.find(x => x.id === b.getAttribute("data-cg-edit"));
        if (!g) return;
        $("cg-id").value = g.id; $("cg-title").value = g.title || ""; $("cg-body").value = g.body || "";
        $("cg-pin").checked = !!g.pinned; $("cg-exp").value = tsToDateInput(g.expiresAt);
      }));
    $("cg-list").querySelectorAll("[data-cg-del]").forEach(b =>
      b.addEventListener("click", async () => {
        try { await deleteDoc(doc(db, "guidelines", b.getAttribute("data-cg-del"))); drawGuideList(); }
        catch (e) { showMsg("cg-msg", friendlyError(e), "err"); }
      }));
  }
  $("cg-clear").addEventListener("click", () => {
    $("cg-id").value = ""; $("cg-title").value = ""; $("cg-body").value = "";
    $("cg-pin").checked = false; $("cg-exp").value = "";
  });
  $("cg-save").addEventListener("click", async () => {
    const title = $("cg-title").value.trim();
    if (!title) return showMsg("cg-msg", "ခေါင်းစဉ် ထည့်ပါ။", "err");
    const data = {
      title, body: $("cg-body").value.trim(), pinned: $("cg-pin").checked,
      expiresAt: expiryInputToTs($("cg-exp").value),
      authorLabel: AUTHOR_LABEL, updatedAt: serverTimestamp()
    };
    try {
      if ($("cg-id").value) await updateDoc(doc(db, "guidelines", $("cg-id").value), data);
      else await addDoc(collection(db, "guidelines"),
        Object.assign(data, { createdBy: state.user.uid, createdAt: serverTimestamp() }));
      showMsg("cg-msg", "✔ သိမ်းပြီးပါပြီ။", "good");
      $("cg-clear").click(); drawGuideList();
    } catch (e) { showMsg("cg-msg", friendlyError(e), "err"); }
  });
  /* --- library --- */
  async function drawLibList() {
    const snap = await getDocs(collection(db, "library"));
    const list = [];
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    $("cl-list").innerHTML = sortByCreatedDesc(list).map(it =>
      '<div class="rowline"><div class="who"><b>' + esc(it.title) + "</b>" +
      '<span class="note">' + esc(it.category || "") + (it.sizeBytes ? " · " + fmtSize(it.sizeBytes) : "") + "</span></div>" +
      '<div class="acts"><button class="toggle" data-cl-edit="' + it.id + '">ပြင်</button>' +
      '<button class="toggle" data-cl-del="' + it.id + '">ဖျက်</button></div></div>').join("") ||
      '<p class="empty">မရှိသေးပါ။</p>';
    $("cl-list").querySelectorAll("[data-cl-edit]").forEach(b =>
      b.addEventListener("click", () => {
        const it = list.find(x => x.id === b.getAttribute("data-cl-edit"));
        if (!it) return;
        $("cl-id").value = it.id; $("cl-title").value = it.title || "";
        $("cl-cat").value = it.category || LIBRARY_CATEGORIES[0]; $("cl-note").value = it.note || "";
        clOldFileUrl = it.fileUrl || "";
        if (clOldFileUrl.indexOf("store:") === 0) {
          $("cl-fileurl").value = "";
          $("cl-curfile").textContent = "လက်ရှိ ဖိုင်: တိုက်ရိုက်တင်ထားသည် (" + (it.fileName || "PDF") + ") — ဖိုင် အသစ် ရွေးမှ အစားထိုးမည်။";
        } else {
          $("cl-fileurl").value = clOldFileUrl;
          $("cl-curfile").textContent = "";
        }
        $("cl-file").value = ""; $("cl-progress").textContent = "";
      }));
    $("cl-list").querySelectorAll("[data-cl-del]").forEach(b =>
      b.addEventListener("click", async () => {
        const it = list.find(x => x.id === b.getAttribute("data-cl-del"));
        try {
          await deleteDoc(doc(db, "library", b.getAttribute("data-cl-del")));
          if (it && it.fileUrl && it.fileUrl.indexOf("store:") === 0) {
            await deleteStoredFile(it.fileUrl.slice(6));
          }
          drawLibList();
        } catch (e) { showMsg("cl-msg", friendlyError(e), "err"); }
      }));
  }
  $("cl-clear").addEventListener("click", () => {
    $("cl-id").value = ""; $("cl-title").value = ""; $("cl-note").value = ""; $("cl-fileurl").value = "";
    $("cl-file").value = ""; $("cl-curfile").textContent = ""; $("cl-progress").textContent = "";
    clOldFileUrl = "";
  });
  $("cl-save").addEventListener("click", async () => {
    const title = $("cl-title").value.trim();
    if (!title) return showMsg("cl-msg", "အမည် ထည့်ပါ။", "err");
    const id = $("cl-id").value;
    const file = $("cl-file").files && $("cl-file").files[0];
    const linkUrl = $("cl-fileurl").value.trim();
    if (file && file.size > MAX_UPLOAD_BYTES) {
      return showMsg("cl-msg", "ဖိုင် အရွယ် 100 MB ထက် ကြီးနေသည် — ပိုသေးသော ဖိုင် သုံးပါ။", "err");
    }
    if (!file && !linkUrl && !(id && clOldFileUrl.indexOf("store:") === 0)) {
      return showMsg("cl-msg", "ဖိုင် ရွေးပါ သို့မဟုတ် link ထည့်ပါ။", "err");
    }
    const btn = $("cl-save");
    btn.disabled = true;
    try {
      let fileUrl, fileName, sizeBytes;
      if (file) {
        $("cl-progress").textContent = "⏳ ဖိုင် တင်နေသည်… 0%";
        const fileId = await uploadLibraryFile(file, frac => {
          $("cl-progress").textContent = "⏳ ဖိုင် တင်နေသည်… " + Math.round(frac * 100) + "%";
        });
        fileUrl = "store:" + fileId; fileName = file.name; sizeBytes = file.size;
      } else if (linkUrl) {
        fileUrl = linkUrl; fileName = linkUrl.split("/").pop() || ""; sizeBytes = 0;
      } else {
        fileUrl = clOldFileUrl; fileName = ""; sizeBytes = 0;
        const prev = libraryCache.find(x => x.id === id);
        if (prev) { fileName = prev.fileName || ""; sizeBytes = prev.sizeBytes || 0; }
      }
      let docId = id;
      let data = {
        title, category: $("cl-cat").value, note: $("cl-note").value.trim(),
        fileUrl, fileName, sizeBytes,
        authorLabel: AUTHOR_LABEL, updatedAt: serverTimestamp()
      };
      if (!docId) {
        const newRef = doc(collection(db, "library"));
        docId = newRef.id;
        data.createdBy = state.user.uid;
        data.createdAt = serverTimestamp();
        await setDoc(newRef, data);
      } else {
        await updateDoc(doc(db, "library", docId), data);
      }
      if (clOldFileUrl.indexOf("store:") === 0 && fileUrl !== clOldFileUrl) {
        await deleteStoredFile(clOldFileUrl.slice(6));
      }
      $("cl-progress").textContent = "";
      showMsg("cl-msg", "✔ သိမ်းပြီးပါပြီ။", "good");
      $("cl-clear").click(); drawLibList();
    } catch (e) { $("cl-progress").textContent = ""; showMsg("cl-msg", friendlyError(e), "err"); }
    btn.disabled = false;
  });

  try { await drawAnnList(); } catch (e) {}
  try { await drawGuideList(); } catch (e) {}
  try { await drawLibList(); } catch (e) {}
}

async function adminDownloads(body) {
  let list = [];
  try {
    const snap = await getDocs(collection(db, "downloads"));
    snap.forEach(d => list.push(Object.assign({ id: d.id }, d.data())));
    list = list.slice().sort((a, b) => {
      const ta = toDate(a.at), tb = toDate(b.at);
      return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
    }).slice(0, 100);
  } catch (e) {
    body.innerHTML = '<div class="card"><p class="empty">ဖတ်၍ မရပါ — ' + esc(friendlyError(e)) + "</p></div>";
    return;
  }
  const kindName = { apk: "APK", pc: "PC/HTML", library: "စာအုပ်" };
  body.innerHTML = '<div class="card"><h2>⬇ Download မှတ်တမ်း (နောက်ဆုံး ' + myNum(list.length) + ')</h2>' +
    (list.length ? list.map(d =>
      '<div class="rowline"><div class="who"><b>' + esc(d.name || "—") +
      (d.version ? ' <span class="chip">v' + esc(d.version) + "</span>" : "") + "</b>" +
      '<span class="note">' + esc(kindName[d.kind] || d.kind || "") + " · " +
      (d.uid === "guest" || !d.uid ? "ဧည့်သည် (Login မဝင်)" : esc(d.email || d.uid)) +
      "<br>" + fmtDateTime(d.at) + "</span></div></div>").join("")
      : '<p class="empty">မှတ်တမ်း မရှိသေးပါ။</p>') + "</div>";
}

async function adminRoles(body) {
  if (!isSuper()) {
    body.innerHTML = '<div class="card"><p class="empty">ဤအပိုင်းကို Admin တစ်ဦးတည်းသာ သုံးနိုင်သည်။</p></div>';
    return;
  }
  let list = [];
  try {
    list = (await fetchAllUsers()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  } catch (e) {
    body.innerHTML = '<div class="card"><p class="empty">ဖတ်၍ မရပါ — ' + esc(friendlyError(e)) + "</p></div>";
    return;
  }
  const roles = ["pending", "member", "deputy", "admin", "rejected"];
  body.innerHTML = '<div class="card"><h2>🔑 Role စီမံရန်</h2>' +
    '<p class="note">Role ပြောင်းခြင်းကို Admin တစ်ဦးတည်းသာ လုပ်နိုင်သည်။ ဒုတိယ (deputy) များမှာ အဖွဲ့ဝင်များဘက်တွင် သာမန် အဖွဲ့ဝင် အဖြစ်သာ ပေါ်သည်။ "ဖျက်" = မှတ်တမ်းကို အပြား ဖျက်သည် (၂ ခါ နှိပ် အတည်ပြုရသည်)။</p>' +
    list.map(u =>
      '<div class="rowline"><div class="who"><b>' + esc(u.name || "—") + "</b>" +
      '<span class="note">' + esc(u.email || "") + "</span></div>" +
      '<div class="acts"><select id="role-' + u.uid + '">' +
      roles.map(r => '<option value="' + r + '"' + (u.role === r ? " selected" : "") + ">" + r + "</option>").join("") +
      '</select><button class="ok" data-role-save="' + u.uid + '">သိမ်း</button>' +
      (u.uid !== (state.user && state.user.uid) ? '<button class="no" data-role-del="' + u.uid + '">ဖျက်</button>' : '') +
      '</div></div>').join("") +
    msgHtml("ro-msg") + "</div>";
  body.querySelectorAll("[data-role-save]").forEach(b =>
    b.addEventListener("click", async () => {
      const uid = b.getAttribute("data-role-save");
      const sel = document.getElementById("role-" + uid);
      try {
        await updateDoc(doc(db, "users", uid), { role: sel.value });
        showMsg("ro-msg", "✔ Role ပြောင်းပြီးပါပြီ။", "good");
        if (uid === state.user.uid) { state.profile.role = sel.value; }
      } catch (e) { showMsg("ro-msg", friendlyError(e), "err"); }
    }));
  // မှတ်တမ်း အပြား ဖျက် (၂ ခါ နှိပ် အတည်ပြု — native confirm မသုံး)
  body.querySelectorAll("[data-role-del]").forEach(b =>
    b.addEventListener("click", async () => {
      const uid = b.getAttribute("data-role-del");
      if (b.getAttribute("data-armed") !== "1") {
        b.setAttribute("data-armed", "1");
        b.textContent = "ဖျက်မှာ သေချာလား?";
        setTimeout(() => { b.removeAttribute("data-armed"); b.textContent = "ဖျက်"; }, 4000);
        return;
      }
      try {
        await deleteDoc(doc(db, "users", uid));
        await adminRoles(body);
        showMsg("ro-msg", "✔ မှတ်တမ်း ဖျက်ပြီးပါပြီ။", "good");
      } catch (e) { showMsg("ro-msg", friendlyError(e), "err"); }
    }));
}

/* ================= INIT ================= */
onAuthStateChanged(auth, async user => {
  state.user = user;
  state.profile = null;
  if (user) {
    // Read-only load: profile ဖန်တီး/ဖြည့်တာကို register/google handler တွေကသာ လုပ်တယ်။
    // (Listener က blank profile နဲ့ ပြိုင်ရေးမိပြီး form data ကို ဖျက်မိတဲ့ race ကို ဖယ်ရှား)
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) state.profile = snap.data();
    } catch (e) { state.profile = null; }
  }
  state.authReady = true;
  render();
});
render();
