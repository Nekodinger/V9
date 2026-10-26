/* ============================================================
   api.js - klien backend V9 (dipakai situs siswa & Panel Guru)
   ------------------------------------------------------------
   apiCall(mode, body)  -> POST /api/backend, mengembalikan JSON
                           (field `error` bila gagal; tidak melempar
                           kecuali jaringan putus).
   aiStream(body, handlers) -> POST /api/ai (Server-Sent Events):
       handlers.onDelta(text), onPhase(phase), onDone(info),
       onTimeout(), onError(message). Mengembalikan { abort() }.
   Content-Type "text/plain" dipakai supaya permintaan lintas-origin
   (mis. dari GitHub Pages) tidak memicu preflight CORS.
   ============================================================ */
function apiUrl(path) {
  const base = (typeof API_BASE === "string" ? API_BASE : "").replace(/\/$/, "");
  return base + path;
}

async function apiCall(mode, body) {
  const payload = Object.assign({ lang: typeof getLang === "function" ? getLang() : "id" }, body || {}, { mode });
  let resp;
  try {
    resp = await fetch(apiUrl("/api/backend"), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const err = new Error(typeof t === "function" ? t("api.network") : "Network error");
    err.network = true;
    throw err;
  }
  let data;
  try { data = await resp.json(); } catch (e) { data = { error: "HTTP " + resp.status }; }
  if (!resp.ok && !data.error) data.error = "HTTP " + resp.status;
  data._status = resp.status;
  return data;
}

function aiStream(body, h) {
  h = h || {};
  const controller = new AbortController();
  const payload = Object.assign({ lang: typeof getLang === "function" ? getLang() : "id" }, body || {});
  (async () => {
    let resp;
    try {
      resp = await fetch(apiUrl("/api/ai"), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (e) {
      if (controller.signal.aborted) return h.onAbort && h.onAbort();
      return h.onError && h.onError(typeof t === "function" ? t("api.network") : "Network error");
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      let msg = "HTTP " + resp.status;
      try { const d = await resp.json(); if (d.error) msg = d.error; } catch (e) { /* abaikan */ }
      return h.onError && h.onError(msg, resp.status);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", finished = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = raw.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.t === "delta") h.onDelta && h.onDelta(ev.text);
          else if (ev.t === "phase") h.onPhase && h.onPhase(ev.phase);
          else if (ev.t === "start") h.onStart && h.onStart(ev);
          else if (ev.t === "done") { finished = true; h.onDone && h.onDone(ev); }
          else if (ev.t === "timeout") { finished = true; h.onTimeout && h.onTimeout(); }
          else if (ev.t === "error") { finished = true; h.onError && h.onError(ev.error); }
        }
      }
      // Stream berhenti tanpa event "done"/"timeout": koneksi terputus di tengah jalan.
      if (!finished) h.onTimeout && h.onTimeout({ network: true });
    } catch (e) {
      if (controller.signal.aborted) return h.onAbort && h.onAbort();
      h.onTimeout && h.onTimeout({ network: true });
    }
  })();
  return { abort: () => controller.abort() };
}
