/* ============================================================
   tests/e2e.mjs - uji ujung-ke-ujung V9 di browser (Playwright)
   Menjalankan tests/dev-server.mjs (PGlite + mock Claude) lalu
   menelusuri alur siswa dan guru. Jalankan: node tests/e2e.mjs
   ============================================================ */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4710, BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, "tests", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const srv = spawn(process.execPath, ["tests/dev-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
srv.stderr.on("data", d => process.stderr.write("[srv] " + d));
await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error("server timeout")), 20000); srv.stdout.on("data", d => { if (String(d).includes("dev server")) { clearTimeout(to); res(); } }); });

const api = async (body) => (await fetch(BASE + "/api/backend", { method: "POST", body: JSON.stringify(body) })).json();
const browser = await chromium.launch();
let passed = 0;
const pageErrors = [];
async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1360, height: 900 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  // CDN tidak bisa diakses dari lingkungan tes: MathJax dilayani dari node_modules
  // (versi sama dengan yang dimuat index.html), font Google diblokir (fallback).
  await pg.route("**/*", r => {
    const u = r.request().url();
    if (/cdn\.jsdelivr\.net\/npm\/mathjax@3\.2\.2\/es5\/(.+)$/.test(u)) {
      const f = path.join(ROOT, "node_modules/mathjax/es5", u.match(/es5\/(.+)$/)[1]);
      return fs.existsSync(f) ? r.fulfill({ path: f, contentType: "text/javascript" }) : r.abort();
    }
    // FONT_DIR (opsional): folder berisi file woff2 Jost/DM Sans untuk screenshot yang akurat
    if (process.env.FONT_DIR && /fonts\.googleapis\.com\/css2/.test(u)) {
      const css = fs.readdirSync(process.env.FONT_DIR).filter(f => /\.woff2$/.test(f)).map(f => {
        const m = f.match(/^(jost|dm-sans)-latin-(\d00)-normal\.woff2$/); if (!m) return "";
        return `@font-face{font-family:"${m[1] === "jost" ? "Jost" : "DM Sans"}";font-weight:${m[2]};src:url(https://fonts.gstatic.com/local/${f}) format("woff2")}`;
      }).join("\n");
      return r.fulfill({ body: css, contentType: "text/css" });
    }
    if (process.env.FONT_DIR && /fonts\.gstatic\.com\/local\//.test(u)) return r.fulfill({ path: path.join(process.env.FONT_DIR, u.split("/local/")[1]), contentType: "font/woff2" });
    return /googleapis|gstatic|jsdelivr/.test(u) ? r.abort() : r.continue();
  });
  pg.on("pageerror", e => pageErrors.push(String(e)));
  return pg;
}
async function step(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) {
    console.error("  FAIL " + name + "\n", e);
    try {
      await pg.screenshot({ path: path.join(SHOTS, "FAIL.png") });
      console.error("state:", await pg.evaluate(() => ({ steps: [...document.querySelectorAll(".gate-step")].filter(x => !x.hidden).map(x => x.id), ls: { ...localStorage }, status: [...document.querySelectorAll(".onboarding-status")].map(x => x.textContent) })));
    } catch (err) { /* abaikan */ }
    await browser.close(); srv.kill(); process.exit(1);
  }
}
async function enterStudent(pg, name, cls, code, mode) {
  await pg.goto(BASE + "/");
  await pg.click("#gate-role-student-btn");
  await pg.fill("#gate-student-name-input", name);
  await pg.fill("#gate-student-class-input", cls);
  await pg.click("#gate-student-info-btn");
  await pg.click("#gate-mode-" + (mode || "self") + "-btn");
  await pg.fill("#gate-student-code-input", code);
  await pg.click("#gate-student-code-btn");
}

const pg = await newPage();
await pg.addInitScript(() => { Math.random = () => 0.9999; }); // urutan soal deterministik di tes

await step("no API-key UI anywhere; brand & logo present", async () => {
  await pg.goto(BASE + "/");
  const text = await pg.evaluate(() => document.documentElement.outerHTML);
  assert.ok(!/gemini|aistudio|AIza|apikey|api key/i.test(text), "no API key wording in index.html");
  assert.ok(await pg.isVisible("#gate-step-role"));
  await pg.screenshot({ path: path.join(SHOTS, "01-gate.png") });
});
await step("wrong code rejected, self-study code accepted", async () => {
  assert.equal(await pg.getAttribute("#gate-role-teacher-link", "href"), "teacher.html");
  // Mode "Belajar di kelas" menolak kode belajar mandiri, lalu ganti ke mode mandiri
  await enterStudent(pg, "Rina Putri", "XII IPA 1", "mandiri-uji", "class");
  await pg.waitForFunction(() => /bukan kode sesi kelas/i.test(document.getElementById("gate-student-code-status").textContent));
  await pg.click("#gate-student-code-back-btn");
  await pg.click("#gate-mode-self-btn");
  assert.match(await pg.textContent("#gate-code-title"), /mandiri/i);
  await pg.fill("#gate-student-code-input", "salah-kode");
  await pg.click("#gate-student-code-btn");
  await pg.waitForFunction(() => /tidak valid/i.test(document.getElementById("gate-student-code-status").textContent));
  await pg.fill("#gate-student-code-input", "mandiri-uji");
  await pg.click("#gate-student-code-btn");
  await pg.waitForSelector("#site-shell:not([hidden])");
  await pg.waitForFunction(() => document.getElementById("user-chip-mode").textContent.trim() !== "", null, { timeout: 10000 });
  assert.equal(await pg.textContent("#user-chip-mode"), "Mandiri");
  await pg.screenshot({ path: path.join(SHOTS, "02-home.png") });
});
await step("Materi: slide viewer renders 31 slides with embeds and builds", async () => {
  await pg.click("#welcome-start-btn");
  await pg.waitForSelector(".deck-slide");
  assert.equal(await pg.textContent(".deck-counter"), "01 / 31");
  await pg.evaluate(() => SlideViewer.current().go(7));
  assert.equal(await pg.locator(".deck-stage iframe.deck-embed").count(), 1, "x-embed becomes sandboxed iframe");
  await pg.evaluate(() => SlideViewer.current().go(12));
  await pg.click('[data-act="next"]');
  assert.equal(await pg.textContent(".deck-counter"), "14 / 31");
  assert.ok(await pg.locator(".deck-stage .build-hidden").count() >= 4, "builds hidden at start");
  await pg.click('[data-act="next"]');
  assert.ok(await pg.locator(".deck-stage .build-hidden").count() >= 3);
  await pg.keyboard.press("ArrowRight");
  await pg.waitForTimeout(3000); // laporan progres slide (debounce 2,5 s)
  await pg.screenshot({ path: path.join(SHOTS, "03-materi.png") });
});
await step("Materi gate: fail keeps modal open, pass unlocks Eksperimen", async () => {
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.click("#progress-next-btn");
  const n = await pg.locator("#confirm-modal .question-card").count();
  assert.equal(n, 5);
  const corr = await pg.evaluate(() => currentTopic.materiCheck.map(q => q.correct));
  for (let i = 0; i < n; i++) await pg.check(`#confirm-modal input[name="cq-${i}"][value="${(corr[i] + 1) % 4}"]`);
  await pg.click("#confirm-modal-submit-btn");
  assert.ok(await pg.isVisible("#confirm-modal"), "modal stays open on fail");
  for (let i = 0; i < n; i++) await pg.check(`#confirm-modal input[name="cq-${i}"][value="${corr[i]}"]`);
  await pg.click("#confirm-modal-submit-btn");
  await pg.waitForSelector("#panel-eksperimen.active .lkpd");
});
await step("LKPD virtual: readings, graph, save, checks without leaking values, submit", async () => {
  await pg.click('.eks-variant-btn[data-variant="virtual"]');
  await pg.waitForSelector('.lkpd[data-mode="virtual"]');
  const I = ["0.5", "1", "1.5", "2", "2.5"];
  for (let k = 0; k < 15; k++) {
    await pg.selectOption("[data-vlab-i]", I[Math.floor(k / 3)]);
    await pg.click('[data-act="vlab-read"]');
    await pg.waitForFunction(() => !document.querySelector('[data-act="vlab-read"]').disabled);
  }
  await pg.click('[data-act="save-table"]');
  await pg.waitForFunction(() => /tersimpan/i.test(document.querySelector("[data-table-status]").textContent));
  const gradient = await pg.evaluate(() => {
    const rows = LKPD._ctx().st.table.rows.map(r => ({ x: Number(r.I), y: r.values.map(v => parseFloat(String(v).replace(",", "."))).reduce((a, b) => a + b, 0) / 3 * 9.81 / 1000 }));
    const n = rows.length, sx = rows.reduce((a, r) => a + r.x, 0), sy = rows.reduce((a, r) => a + r.y, 0), sxx = rows.reduce((a, r) => a + r.x * r.x, 0), sxy = rows.reduce((a, r) => a + r.x * r.y, 0);
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
  });
  const B = gradient / 0.045;
  await pg.fill('[data-calc="calcB"]', (B * 3).toFixed(3));
  await pg.click('[data-check="calcB"]');
  const fbWrong = await pg.textContent('[data-fb="calcB"]');
  assert.match(fbWrong, /terlalu besar/);
  assert.ok(!fbWrong.includes(B.toFixed(2)) && !fbWrong.includes(B.toFixed(2).replace(".", ",")), "wrong feedback must not reveal B");
  await pg.fill('[data-calc="calcB"]', B.toFixed(3).replace(".", ","));
  await pg.click('[data-check="calcB"]');
  assert.match(await pg.textContent('[data-fb="calcB"]'), /Tepat/);
  for (const id of ["predict", "gradient", "reverse", "intercept"]) {
    const correct = await pg.evaluate(i => LKPD._ctx().def.sections.find(s => s.id === i).correct, id);
    await pg.check(`input[name="lk-${id}"][value="${correct}"]`);
    await pg.click(`[data-check="${id}"]`);
  }
  await pg.click('[data-reveal="conclusion"]');
  assert.ok(await pg.isHidden('[data-model="conclusion"]'), "sample answer locked until student writes");
  await pg.fill('[data-open="conclusion"]', "F sebanding dengan I karena grafik lurus melalui titik asal; B sekitar 0,2 T.");
  await pg.fill('[data-open="virtual-vs-real"]', "Pemanasan kawat dan kawat menyentuh magnet tidak muncul pada alat virtual.");
  await pg.fill("[data-group]", "3");
  const steps = await pg.locator(".lkpd [data-tick]").count();
  for (let i = 0; i < steps; i++) await pg.locator(".lkpd [data-tick]").nth(i).check();
  assert.equal(await pg.textContent(".lkpd-score-big"), "5/5");
  await pg.click('[data-act="submit"]');
  await pg.waitForSelector("[data-submitted]:not([hidden])");
  await pg.locator(".lkpd-head").scrollIntoViewIfNeeded();
  await pg.screenshot({ path: path.join(SHOTS, "04-lkpd.png") });
});
await step("Eksperimen gate -> teacher approves -> Latihan & Makerspace unlock", async () => {
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.click("#progress-next-btn");
  const corr = await pg.evaluate(() => currentTopic.eksperimenCheck.map(q => q.correct));
  for (let i = 0; i < corr.length; i++) await pg.check(`#confirm-modal input[name="cq-${i}"][value="${corr[i]}"]`);
  await pg.click("#confirm-modal-submit-btn");
  await pg.waitForSelector("#eksperimen-gate-banner.gate-pending");
  const ro = await api({ mode: "teacher_roster", controlCode: "guru-uji" });
  const req = ro.gatePending.find(g => g.studentId === "Rina Putri (XII IPA 1)");
  assert.ok(req && /5\/5/.test(req.summary), "gate summary includes LKPD score: " + (req && req.summary));
  await api({ mode: "teacher_gate_decide", controlCode: "guru-uji", topicId: req.topicId, studentId: req.studentId, stage: "eksperimen", decision: "approved" });
  await pg.waitForSelector("#eksperimen-gate-banner.gate-approved", { timeout: 15000 });
  assert.ok(!(await pg.getAttribute('.tab-btn[data-tab="lab"]', "class")).includes("locked"));
});
await step("Latihan answers are recorded", async () => {
  await pg.click('.tab-btn[data-tab="latihan"]');
  await pg.locator("#panel-latihan input[type=radio]").first().check();
  await pg.locator("[data-latihan-check]").first().click();
  await pg.waitForSelector(".latihan-fb:not([hidden])");
});
await step("Makerspace: streaming generate, edit, reflection to teacher", async () => {
  await pg.click('.tab-btn[data-tab="lab"]');
  await pg.fill("#pf-goal", "mengamati hubungan arus dan gaya pada kawat");
  await pg.click("#pf-build-btn");
  await pg.click("#generate-btn");
  await pg.waitForFunction(() => /selesai/.test(document.getElementById("generate-status").textContent), null, { timeout: 15000 });
  const src = await pg.getAttribute("#preview-frame", "srcdoc");
  assert.ok(src.startsWith("<!DOCTYPE html>"));
  // Koneksi putus di tengah streaming -> dilanjutkan otomatis tanpa klik
  await pg.evaluate(() => fetch("/__dropnext"));
  await pg.click("#generate-btn");
  await pg.waitForFunction(() => /otomatis/.test(document.getElementById("generate-status").textContent), null, { timeout: 15000 });
  await pg.waitForFunction(() => /selesai|dilanjutkan/.test(document.getElementById("generate-status").textContent), null, { timeout: 20000 });
  const src2 = await pg.getAttribute("#preview-frame", "srcdoc");
  assert.ok(src2.startsWith("<!DOCTYPE html>") && /<\/html>\s*$/.test(src2), "auto-resumed HTML must be complete");
  assert.equal(await pg.isHidden("#continue-gen-btn"), true);
  await pg.fill("#edit-followup-input", "tambahkan label satuan");
  await pg.click("#edit-followup-btn");
  await pg.waitForFunction(() => /direvisi/.test(document.getElementById("edit-followup-status").textContent), null, { timeout: 15000 });
  await pg.fill("#lab-reflection-input", "Saat arus nol gaya juga nol, sesuai F = BIL; saat arus dua kali gaya dua kali.");
  await pg.click("#lab-reflection-submit-btn");
  await pg.waitForSelector("#lab-gate-banner.gate-pending");
  await pg.locator(".lab-grid").scrollIntoViewIfNeeded();
  await pg.screenshot({ path: path.join(SHOTS, "05-makerspace.png") });
});
await step("Tutor chat streams a reply", async () => {
  await pg.click("#chatbot-toggle-btn");
  await pg.fill("#chatbot-input", "Kenapa F = BIL?");
  await pg.press("#chatbot-input", "Enter");
  await pg.waitForFunction(() => /Pertanyaan bagus/.test(document.getElementById("chatbot-messages").textContent));
  await pg.screenshot({ path: path.join(SHOTS, "06-chat.png") });
  await pg.click("#chatbot-close-btn");
});
await step("Class session: join, quiz, session end keeps student inside (V7 bug fixed)", async () => {
  const s = await api({ mode: "teacher_session", controlCode: "guru-uji", action: "start", topicId: "magnetic-fields", tabIndex: 0 });
  await api({ mode: "quiz_bank_save", controlCode: "guru-uji", topicId: "magnetic-fields", questions: [{ type: "mcq", question: "Satuan B adalah", options: ["T", "N", "A", "Wb"], correct: 0 }, { type: "short", question: "Definisikan tesla." }] });
  const bank = await api({ mode: "quiz_bank_get", controlCode: "guru-uji", topicId: "magnetic-fields" });
  await pg.click("#settings-btn");
  await pg.fill("#class-session-code-input", s.state.code);
  await pg.click("#class-session-join-btn");
  await pg.waitForFunction(() => /Kelas/.test(document.getElementById("user-chip-mode").textContent));
  await pg.click("#settings-close-btn");
  await api({ mode: "quiz_publish", controlCode: "guru-uji", topicId: "magnetic-fields", questions: bank.questions });
  await pg.evaluate(() => syncClassSession());
  await pg.waitForSelector("#quiz-toggle-btn:not([hidden])");
  await pg.click("#quiz-toggle-btn");
  await pg.locator("#quiz-modal-body input[type=radio]").first().check();
  await pg.fill("#quiz-modal-body textarea", "1 T = 1 N A^-1 m^-1");
  await pg.click("#quiz-modal-submit-btn");
  await pg.waitForFunction(() => document.getElementById("quiz-modal-submit-btn").disabled && document.getElementById("quiz-modal-status").textContent.length > 3);
  await pg.click("#quiz-modal-close-btn");
  await api({ mode: "teacher_session", controlCode: "guru-uji", action: "end" });
  await pg.evaluate(() => syncClassSession());
  await pg.waitForFunction(() => document.getElementById("user-chip-mode").textContent === "Mandiri");
  assert.ok(await pg.isVisible("#site-shell"), "student stays in the site");
  assert.ok(await pg.isHidden("#onboarding-gate"));
});
await step("Teacher panel: records, detail with LKPD answers, Excel & PDF export", async () => {
  const tp = await newPage({ width: 1400, height: 900 });
  await tp.goto(BASE + "/teacher.html");
  await tp.fill("#teacher-control-input", "guru-uji");
  await tp.click("#teacher-login-btn");
  await tp.waitForSelector("#teacher-panel:not([hidden])");
  // Guru hanya bisa memilih topik yang terlihat oleh siswa (VISIBLE_TOPIC_IDS)
  const topicOpts = await tp.$$eval("#teacher-topic-select option, #quiz-topic-select option", os => os.map(o => o.value));
  assert.ok(topicOpts.length >= 2 && topicOpts.every(v => v === "magnetic-fields"), "teacher topic lists: " + topicOpts.join(","));
  await tp.screenshot({ path: path.join(SHOTS, "07-teacher-session.png") });
  await tp.click('.t-tab[data-pane="records"]');
  await tp.waitForSelector("#records-body .student-link");
  const rowText = await tp.textContent("#records-body");
  assert.match(rowText, /Rina Putri/); assert.match(rowText, /terkumpul/);
  await tp.screenshot({ path: path.join(SHOTS, "08-teacher-records.png") });
  await tp.click('#records-body .student-link:has-text("Rina Putri")');
  await tp.waitForSelector("#student-modal-body .detail-section");
  const detail = await tp.textContent("#student-modal-body");
  assert.match(detail, /F sebanding dengan I/); assert.match(detail, /LKPD/); assert.match(detail, /Satuan B adalah/); assert.match(detail, /Saat arus nol/);
  await tp.screenshot({ path: path.join(SHOTS, "09-teacher-detail.png") });
  const [d1] = await Promise.all([tp.waitForEvent("download"), tp.click("#student-pdf-btn")]);
  const pdfPath = path.join(SHOTS, "student.pdf"); await d1.saveAs(pdfPath);
  assert.ok(fs.statSync(pdfPath).size > 3000 && fs.readFileSync(pdfPath).slice(0, 4).toString() === "%PDF");
  await tp.click("#student-modal-close-btn");
  const [d2] = await Promise.all([tp.waitForEvent("download"), tp.click("#export-xlsx-btn")]);
  const xPath = path.join(SHOTS, "rekap.xlsx"); await d2.saveAs(xPath);
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(xPath);
  assert.deepEqual(wb.SheetNames, ["Rekap", "Konfirmasi", "LKPD", "Data Eksperimen", "Latihan", "Kuis", "Makerspace", "Checkpoint"]);
  const lk = XLSX.utils.sheet_to_json(wb.Sheets.LKPD);
  assert.ok(lk.find(r => /^\d\d · Uraian$/.test(r.Butir) && /sebanding/.test(r.Jawaban)), "LKPD conclusion exported");
  const exp = XLSX.utils.sheet_to_json(wb.Sheets["Data Eksperimen"]);
  assert.equal(exp.filter(r => r.Siswa === "Rina Putri").length, 5);
  const quiz = XLSX.utils.sheet_to_json(wb.Sheets.Kuis);
  assert.ok(quiz.find(r => r.Siswa === "Rina Putri" && r["Benar (1/0)"] === 1));
  const lat = XLSX.utils.sheet_to_json(wb.Sheets.Latihan);
  assert.ok(lat.find(r => r.Siswa === "Rina Putri"));
  const [d3] = await Promise.all([tp.waitForEvent("download"), tp.click("#export-pdf-btn")]);
  await d3.saveAs(path.join(SHOTS, "rekap.pdf"));
  await tp.click('.t-tab[data-pane="quiz"]');
  await tp.click("#quiz-generate-btn");
  await tp.waitForFunction(() => !document.getElementById("quiz-generate-btn").disabled && /\d/.test(document.getElementById("quiz-generate-status").textContent));
  await tp.screenshot({ path: path.join(SHOTS, "10-teacher-quiz.png") });
  await tp.click('.t-tab[data-pane="usage"]');
  await tp.waitForSelector("#usage-body table");
  await tp.screenshot({ path: path.join(SHOTS, "11-teacher-usage.png") });
});
await step("English UI and phone layout", async () => {
  const mp = await newPage({ width: 390, height: 844 });
  await mp.goto(BASE + "/");
  await Promise.all([mp.waitForEvent("load"), mp.click('.lang-switch-btn[data-lang="en"]')]);
  await mp.waitForSelector("#gate-step-role");
  assert.match(await mp.textContent("#gate-step-role h2"), /Who is signing in/);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.ok(!overflow, "no horizontal scroll on phone gate");
  await mp.screenshot({ path: path.join(SHOTS, "12-phone-gate.png"), fullPage: true });
});
await step("Validator: explore code via gate link", async () => {
  const vp = await newPage();
  await vp.goto(BASE + "/");
  await vp.click("#gate-role-guest-btn");
  await vp.fill("#gate-guest-code-input", "kode-salah");
  await vp.click("#gate-guest-code-btn");
  await vp.waitForFunction(() => document.getElementById("gate-guest-code-status").textContent.length > 3);
  await vp.fill("#gate-guest-code-input", "  jelajah-uji ");
  await vp.click("#gate-guest-code-btn");
  await vp.waitForSelector("#site-shell:not([hidden])");
  await vp.close();
});
await step("no uncaught page errors", async () => {
  assert.deepEqual(pageErrors, []);
});
console.log(`\n${passed} E2E steps passed`);
await browser.close();
srv.kill();
process.exit(0);
