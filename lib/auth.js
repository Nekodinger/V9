/* ============================================================
   lib/auth.js - kode akses & token siswa
   ------------------------------------------------------------
   Semua kode rahasia sekarang ada di SERVER (Environment Variables
   Vercel), tidak lagi di js/config.js yang bisa dibaca siapa pun:
     TEACHER_CONTROL_CODE  wajib - kode masuk Panel Guru
     SELF_STUDY_CODE       opsional - kode "Belajar Mandiri" untuk siswa
     EXPLORE_CODE          opsional - kode "Eksplorasi Bebas" (semua tab terbuka)
     ACCESS_SECRET         opsional - kunci tanda tangan token (default:
                           diturunkan dari TEACHER_CONTROL_CODE)
   Setelah siswa lolos gerbang (kode sesi kelas / kode mandiri / kode
   eksplorasi), server memberi TOKEN bertanda tangan HMAC yang berlaku
   30 hari. Token inilah yang dipakai untuk memanggil AI, jadi kalau sesi
   kelas berakhir siswa tetap bisa lanjut belajar mandiri (bug V7: siswa
   dilempar kembali ke gerbang).
   ============================================================ */
import crypto from "node:crypto";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret() {
  const base = process.env.ACCESS_SECRET || ("ps9:" + (process.env.TEACHER_CONTROL_CODE || "unset"));
  return crypto.createHash("sha256").update(base).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// extra: { s: studentId, v: versi token akun } untuk token akun siswa.
export function issueToken(kind, extra) {
  const payload = Object.assign({ k: kind, e: Date.now() + TOKEN_TTL_MS, n: crypto.randomBytes(6).toString("hex") }, extra || {});
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return body + "." + sig;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || token.length > 700) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!p || typeof p.e !== "number" || p.e < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function eqCode(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y) return false;
  const ha = crypto.createHash("sha256").update(x).digest();
  const hb = crypto.createHash("sha256").update(y).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function teacherConfigured() {
  return !!String(process.env.TEACHER_CONTROL_CODE || "").trim();
}

export function isTeacher(code) {
  return teacherConfigured() && eqCode(code, process.env.TEACHER_CONTROL_CODE);
}

export function selfStudyCode() {
  return String(process.env.SELF_STUDY_CODE || "belajar-mandiri").trim();
}

export function exploreCode() {
  return String(process.env.EXPLORE_CODE || "").trim();
}

export function matchSelfStudy(code) {
  return eqCode(code, selfStudyCode());
}

export function matchExplore(code) {
  return !!exploreCode() && eqCode(code, exploreCode());
}
