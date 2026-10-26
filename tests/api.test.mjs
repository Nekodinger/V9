/* Uji API backend V9 end-to-end (PGlite + mock Claude). Jalankan: node tests/api.test.mjs */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4510;
const BASE = `http://127.0.0.1:${PORT}`;
const T = "guru-uji";

const child = spawn(process.execPath, ["tests/dev-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), LIMIT_SIM_PER_STUDENT: "2" }, stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", d => process.stderr.write("[srv] " + d));
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("server start timeout")), 20000);
  child.stdout.on("data", d => { if (String(d).includes("dev server")) { clearTimeout(to); res(); } });
});

let passed = 0;
async function api(body, headers = {}) {
  const r = await fetch(BASE + "/api/backend", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
async function aiStream(body) {
  const r = await fetch(BASE + "/api/ai", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
  if (!r.headers.get("content-type").includes("event-stream")) return { status: r.status, data: await r.json() };
  const txt = await r.text();
  const events = txt.split("\n\n").filter(Boolean).map(l => JSON.parse(l.replace(/^data: /, "")));
  return { status: r.status, events, text: events.filter(e => e.t === "delta").map(e => e.text).join("") };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n", e); child.kill(); process.exit(1); }
}

const S1 = "Budi Santoso (XII IPA 1)";
const S2 = "Siti <b>Aminah</b> (XII IPA 1)";
let token, classCode, quizId;

await test("health", async () => {
  const r = await fetch(BASE + "/api/health"); const d = await r.json();
  assert.equal(d.ok, true); assert.equal(d.ai, true); assert.equal(d.models.chat, "claude-haiku-5-5"); assert.equal(d.models.sim, "claude-opus-5-5");
});
await test("verify_access rejects wrong code", async () => {
  const r = await api({ mode: "verify_access", code: "salah", studentId: S1 });
  assert.equal(r.status, 403);
});
await test("verify_access self-study gives token", async () => {
  const r = await api({ mode: "verify_access", code: "MANDIRI-UJI", studentId: S1, progress: { "magnetic-fields": 1 } });
  assert.equal(r.status, 200); assert.equal(r.data.kind, "self"); assert.ok(r.data.token.includes("."));
  assert.equal(r.data.progress["magnetic-fields"], 1);
  token = r.data.token;
});
await test("verify_access explore", async () => {
  const r = await api({ mode: "verify_access", code: "jelajah-uji" });
  assert.equal(r.data.kind, "explore");
});
await test("teacher auth required", async () => {
  const r = await api({ mode: "teacher_roster", controlCode: "x" });
  assert.equal(r.status, 401);
});
await test("teacher starts session; student joins with class code", async () => {
  const r = await api({ mode: "teacher_session", controlCode: T, action: "start", topicId: "magnetic-fields", tabIndex: 0 });
  assert.equal(r.data.state.active, true); classCode = r.data.state.code; assert.equal(classCode.length, 6);
  const j = await api({ mode: "verify_access", code: classCode.toLowerCase(), studentId: S2 });
  assert.equal(j.data.kind, "class");
  const s = await api({ mode: "session_sync", code: classCode, studentId: S2, topicId: "magnetic-fields", tabIndex: 1, progress: { "magnetic-fields": 2 } });
  assert.equal(s.data.inSession, true); assert.equal(s.data.progress["magnetic-fields"], 2);
  const s2 = await api({ mode: "session_sync", code: classCode, studentId: S2, progress: { "magnetic-fields": 0 } });
  assert.equal(s2.data.progress["magnetic-fields"], 2, "progress never goes backwards");
  const ro = await api({ mode: "teacher_roster", controlCode: T });
  assert.ok(ro.data.roster[S2].inSession); assert.equal(ro.data.roster[S2].tabIndex, 1);
});
await test("gate submit -> pending -> approve", async () => {
  await api({ mode: "gate_submit", topicId: "magnetic-fields", studentId: S1, stage: "eksperimen", summary: "lulus 2/2" });
  const st = await api({ mode: "gate_status", topicId: "magnetic-fields", studentId: S1 });
  assert.equal(st.data.eksperimen.status, "pending");
  const ro = await api({ mode: "teacher_roster", controlCode: T });
  assert.equal(ro.data.gatePending.length, 1);
  const d = await api({ mode: "teacher_gate_decide", controlCode: T, topicId: "magnetic-fields", studentId: S1, stage: "eksperimen", decision: "approved" });
  assert.equal(d.data.ok, true);
  const again = await api({ mode: "teacher_gate_decide", controlCode: T, topicId: "magnetic-fields", studentId: S1, stage: "eksperimen", decision: "approved" });
  assert.equal(again.status, 404);
  const st2 = await api({ mode: "gate_status", topicId: "magnetic-fields", studentId: S1 });
  assert.equal(st2.data.eksperimen.status, "approved");
});
await test("quiz bank, generate, publish, submit, results, archive", async () => {
  const g = await api({ mode: "quiz_generate", controlCode: T, topicTitle: "Magnetic Fields", count: 2, questionType: "mixed" });
  assert.equal(g.status, 200); assert.equal(g.data.questions.length, 2);
  const sv = await api({ mode: "quiz_bank_save", controlCode: T, topicId: "magnetic-fields", questions: g.data.questions });
  assert.equal(sv.data.questions.length, 2);
  const gb = await api({ mode: "quiz_bank_get", controlCode: T, topicId: "magnetic-fields" });
  assert.equal(gb.data.questions[0].correct, 0);
  const p = await api({ mode: "quiz_publish", controlCode: T, topicId: "magnetic-fields", questions: gb.data.questions });
  quizId = p.data.quiz.id;
  const s = await api({ mode: "session_sync", code: classCode, studentId: S2 });
  assert.equal(s.data.activeQuiz.id, quizId); assert.equal(s.data.activeQuiz.questions[0].correct, undefined, "answer key never sent to students");
  const sub = await api({ mode: "quiz_submit", code: classCode, studentId: S2, quizId, answers: { [gb.data.questions[0].id]: 0, [gb.data.questions[1].id]: "1 T = 1 N/(A m)" } });
  assert.equal(sub.data.ok, true);
  const s3 = await api({ mode: "session_sync", code: classCode, studentId: S2 });
  assert.equal(s3.data.activeQuiz.submitted, true);
  const res = await api({ mode: "quiz_results", controlCode: T });
  assert.equal(res.data.answers[0].score, 100);
  // publish a second quiz: first quiz's answers must still exist
  await api({ mode: "quiz_publish", controlCode: T, topicId: "magnetic-fields", questions: [gb.data.questions[1]] });
  const old = await api({ mode: "quiz_results", controlCode: T, quizId });
  assert.equal(old.data.answers.length, 1);
  const list = await api({ mode: "quiz_list", controlCode: T });
  assert.equal(list.data.quizzes.length, 2); assert.equal(list.data.quizzes.filter(z => z.active).length, 1);
});
await test("record events, lkpd save/get, experiment save with AI check", async () => {
  const e = await api({ mode: "record_event", studentId: S1, topicId: "magnetic-fields", kind: "materi_check", item: "attempt", score: 80, payload: { answers: [1, 2, 0, 3, 1] } });
  assert.equal(e.data.ok, true);
  const bad = await api({ mode: "record_event", studentId: S1, kind: "hack" });
  assert.equal(bad.status, 400);
  await api({ mode: "lkpd_save", studentId: S1, topicId: "magnetic-fields", lkpdMode: "lab", data: { answers: { predict: 1 } }, progress: 40 });
  await api({ mode: "lkpd_save", studentId: S1, topicId: "magnetic-fields", lkpdMode: "lab", data: { answers: { predict: 1, conclusion: "F sebanding I" } }, progress: 100, submit: true });
  await api({ mode: "lkpd_save", studentId: S1, topicId: "magnetic-fields", lkpdMode: "lab", data: { answers: { predict: 2 } }, progress: 100 });
  const g = await api({ mode: "lkpd_get", studentId: S1, topicId: "magnetic-fields" });
  assert.equal(g.data.modes.lab.status, "submitted", "a submitted LKPD stays submitted after later autosaves");
  assert.equal(g.data.modes.lab.data.answers.predict, 2);
  const x = await api({ mode: "eksperimen_data_save", studentId: S1, topicId: "magnetic-fields", variant: "laboratorium", context: "Current balance", rows: [{ I: 0.5, values: [0.51, 0.5, null] }, { I: 1, values: [1.02, "", 1.0] }], meta: { replicateCount: 3 }, analysis: { gradient: 0.02, B: 0.4 } });
  assert.equal(x.data.ok, true); assert.match(x.data.feedback, /wajar/);
});
await test("AI chat streams Haiku with thinking disabled", async () => {
  const r = await aiStream({ mode: "chat", token, studentId: S1, topic: "Magnetic Fields", message: "Apa itu F=BIL?", history: [{ role: "model", text: "Halo" }, { role: "user", text: "hai" }, { role: "model", text: "Silakan" }] });
  assert.equal(r.status, 200); assert.ok(r.text.length > 20); assert.equal(r.events.at(-1).t, "done");
  const log = await (await fetch(BASE + "/__mocklog")).json();
  const chat = log.filter(l => l.model === "claude-haiku-5-5" && l.stream).at(-1);
  assert.deepEqual(chat.thinking, { type: "disabled" }); assert.equal(chat.output_config.effort, "low"); assert.equal(chat.system, true);
});
await test("AI requires token", async () => {
  const r = await aiStream({ mode: "chat", message: "hai" });
  assert.equal(r.status, 401);
});
await test("AI simulate streams Opus HTML, edit and continue work, quota enforced", async () => {
  const r = await aiStream({ mode: "simulate", token, studentId: S1, topicId: "magnetic-fields", prompt: "Buat simulasi F=BIL" });
  assert.ok(r.text.startsWith("<!DOCTYPE html>")); assert.ok(r.text.trim().endsWith("</html>"));
  assert.ok(r.events.some(e => e.t === "phase" && e.phase === "thinking"));
  const log = await (await fetch(BASE + "/__mocklog")).json();
  const sim = log.filter(l => l.model === "claude-opus-5-5").at(-1);
  assert.equal(sim.thinking, undefined, "Opus 5.5 thinking must not be set"); assert.equal(sim.output_config.effort, "low"); assert.equal(sim.max_tokens, 32000);
  const ed = await aiStream({ mode: "edit", token, studentId: S1, html: r.text, instruction: "ubah warna" });
  assert.ok(ed.text.includes("</html>"));
  const cont = await aiStream({ mode: "continue", token, studentId: S1, prompt: "Buat simulasi F=BIL", partial: r.text.slice(0, 300) });
  assert.ok(cont.text.length > 10);
  const dc = await api({ mode: "teacher_student_detail", controlCode: T, studentId: S1 });
  const lastSim = dc.data.events.filter(e => e.kind === "lab_generate" || e.kind === "lab_edit").sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.equal(lastSim.kind, "lab_edit"); assert.equal(lastSim.payload.continued, true);
  assert.equal(lastSim.payload.html, r.text.slice(0, 300) + cont.text, "continuation merged into the latest logged simulation");
  await aiStream({ mode: "simulate", token, studentId: S1, prompt: "lagi" });
  const third = await aiStream({ mode: "simulate", token, studentId: S1, prompt: "lagi lagi" });
  assert.equal(third.status, 429);
});
await test("teacher overview, detail, export include everything; XSS name stored raw", async () => {
  const o = await api({ mode: "teacher_overview", controlCode: T });
  assert.ok(o.data.students.find(s => s.studentId === S2 && s.className === "XII IPA 1" && s.name === "Siti <b>Aminah</b>"));
  assert.ok(o.data.events.find(e => e.studentId === S1 && e.kind === "materi_check" && e.best === 80));
  assert.ok(o.data.lkpd.find(l => l.studentId === S1 && l.status === "submitted"));
  const d = await api({ mode: "teacher_student_detail", controlCode: T, studentId: S1 });
  assert.ok(d.data.events.find(e => e.kind === "lab_generate" && e.payload.html.includes("</html>")), "generated simulation logged");
  assert.equal(d.data.experiments[0].analysis.B, 0.4);
  assert.equal(d.data.experiments[0].rows[1].values[1], null);
  const x = await api({ mode: "teacher_export", controlCode: T });
  assert.equal(x.data.students.length, 2); assert.equal(x.data.quizzes.length, 2);
  const u = await api({ mode: "teacher_usage", controlCode: T });
  assert.equal(u.data.today.simulate, 2);
});
await test("end session -> student keeps token, sync says not in session", async () => {
  await api({ mode: "teacher_session", controlCode: T, action: "end" });
  const s = await api({ mode: "session_sync", code: classCode, studentId: S2 });
  assert.equal(s.data.inSession, false); assert.equal(s.data.activeQuiz, null);
  const sub = await api({ mode: "quiz_submit", code: classCode, studentId: S2, quizId, answers: {} });
  assert.equal(sub.status, 409);
});
await test("foreign origin rejected, delete student works", async () => {
  const r = await api({ mode: "health" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const d = await api({ mode: "teacher_delete_student", controlCode: T, studentId: S2 });
  assert.equal(d.data.ok, true);
  const o = await api({ mode: "teacher_overview", controlCode: T });
  assert.equal(o.data.students.length, 1);
});

console.log(`\n${passed} API tests passed`);
child.kill();
process.exit(0);
