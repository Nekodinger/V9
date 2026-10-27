/* POST /api/backend  { mode: "...", ... }  -> JSON
   Semua aksi non-AI-streaming (sesi kelas, gate, kuis, LKPD, rekap guru). */
import { applyCors, originAllowed, readJsonBody, sendJson } from "../lib/http.js";
import { dispatch, HttpError } from "../lib/handlers.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  if (!originAllowed(req)) return sendJson(res, 403, { error: "Origin not allowed. Add it to ALLOWED_ORIGINS." });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: "Invalid JSON body." }); }
  body = body && typeof body === "object" ? body : {};
  // Alamat IP hanya dipakai pembatas percobaan login (tidak disimpan sebagai data siswa)
  body._ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
  try {
    const out = await dispatch(body);
    return sendJson(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status || 400, e.code ? { error: e.message, code: e.code } : { error: e.message });
    if (e && e.code === "DATABASE_NOT_CONFIGURED") {
      return sendJson(res, 503, { error: body && body.lang === "en"
        ? "The database is not connected yet. Add DATABASE_URL (Supabase) in Vercel > Settings > Environment Variables, then redeploy."
        : "Database belum terhubung. Tambahkan DATABASE_URL (Supabase) di Vercel > Settings > Environment Variables, lalu redeploy." });
    }
    console.error("[backend]", body && body.mode, e);
    return sendJson(res, 500, { error: (body && body.lang === "en" ? "Server error: " : "Terjadi kesalahan di server: ") + String(e && e.message || e).slice(0, 300) });
  }
}
