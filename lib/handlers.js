/* ============================================================
   lib/handlers.js - semua "mode" backend non-streaming
   ------------------------------------------------------------
   Pengganti apps-script/Code.gs V7. Bentuk permintaan tetap sama
   ({ mode: "...", ... }) supaya alur front-end lama tetap dikenali,
   tetapi data sekarang tersimpan di PostgreSQL (Supabase), bukan
   PropertiesService/Google Sheets: lebih cepat, tidak ada batas 9 KB
   per properti, dan SEMUA jawaban siswa terekam permanen untuk Panel Guru.
   ============================================================ */
import crypto from "node:crypto";
import { q, one, J, jsonSize } from "./db.js";
import { issueToken, verifyToken, isTeacher, teacherConfigured, matchSelfStudy, matchExplore, exploreCode } from "./auth.js";
import { aiConfigured, createMessage, describeAiError, extractJson, MODELS } from "./anthropic.js";
import { buildDataCheckPrompt, buildQuizPrompt } from "./prompts.js";
import { takeQuota, limits, usageToday } from "./usage.js";

const MAX_SID = 80;
const ROSTER_WINDOW_MS = 5 * 60 * 1000;
const VALID_LEVELS = ["dasar", "menengah", "lanjut"];
const STAGES = ["eksperimen", "lab"];
const EVENT_KINDS = ["materi_check", "eksperimen_check", "latihan", "lab_prompt", "lab_generate", "lab_edit", "lab_reflection", "vlab_check", "lkpd_check", "slides_progress", "quiz_submit", "gate_submit"];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const sidOf = b => str(b.studentId, MAX_SID);
const topicOf = b => str(b.topicId, 60);
const now = () => Date.now();
const lvl = v => (VALID_LEVELS.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);
const isEn = b => b.lang === "en";
// ID tamu/validator ("Tamu-XXXX") tidak disimpan sebagai data siswa.
export const isGuestId = sid => /^Tamu-/.test(String(sid || ""));

function requireTeacher(b) {
  if (!teacherConfigured()) throw new HttpError(503, isEn(b) ? "TEACHER_CONTROL_CODE is not set on the server yet (Vercel > Settings > Environment Variables)." : "TEACHER_CONTROL_CODE belum diatur di server (Vercel > Settings > Environment Variables).");
  if (!isTeacher(b.controlCode)) throw new HttpError(401, isEn(b) ? "Wrong or missing teacher control code." : "Kode kontrol guru salah atau belum diisi.");
}

/* ---------------- Sesi kelas ---------------- */
async function readSession() {
  const r = await one(`select active, code, topic_id, tab_index, updated_at from ps_session where id = 1`);
  if (!r) return { active: false, code: null, topicId: null, tabIndex: null, updatedAt: null };
  return { active: !!r.active, code: r.code || null, topicId: r.topic_id || null, tabIndex: r.tab_index == null ? null : Number(r.tab_index), updatedAt: r.updated_at };
}
async function writeSession(s) {
  await q(`insert into ps_session (id, active, code, topic_id, tab_index, updated_at) values (1, $1, $2, $3, $4, $5)
           on conflict (id) do update set active = excluded.active, code = excluded.code, topic_id = excluded.topic_id,
           tab_index = excluded.tab_index, updated_at = excluded.updated_at`,
    [!!s.active, s.code, s.topicId, s.tabIndex, s.updatedAt]);
}
function codeMatches(state, code) {
  return !!(state.active && state.code && code && String(code).trim().toUpperCase() === state.code.toUpperCase());
}
function generateSessionCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, x => chars[x % chars.length]).join("");
}

/* ---------------- Siswa ---------------- */
function mergeProgress(a, b) {
  const out = { ...(a && typeof a === "object" ? a : {}) };
  if (b && typeof b === "object") {
    Object.keys(b).slice(0, 40).forEach(k => {
      const v = parseInt(b[k], 10);
      if (!isNaN(v) && v >= 0 && v <= 3) out[k.slice(0, 60)] = Math.max(out[k] == null ? -1 : out[k], v);
    });
  }
  return out;
}
function splitName(sid) {
  const m = /^(.*)\(([^()]*)\)\s*$/.exec(sid);
  return m ? { name: m[1].trim(), cls: m[2].trim() } : { name: sid, cls: "" };
}
async function touchStudent(sid, fields) {
  if (!sid) return null;
  const existing = await one(`select progress from ps_students where student_id = $1`, [sid]);
  const progress = mergeProgress(existing ? existing.progress : {}, fields.progress);
  const nm = splitName(sid);
  await q(`insert into ps_students (student_id, name, class_name, created_at, last_seen, session_code, topic_id, tab_index, level, progress)
           values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9::jsonb)
           on conflict (student_id) do update set
             last_seen = excluded.last_seen,
             session_code = excluded.session_code,
             topic_id = coalesce(excluded.topic_id, ps_students.topic_id),
             tab_index = coalesce(excluded.tab_index, ps_students.tab_index),
             level = coalesce(excluded.level, ps_students.level),
             progress = excluded.progress`,
    [sid, nm.name, nm.cls, now(), fields.sessionCode || null, fields.topicId || null,
     typeof fields.tabIndex === "number" ? fields.tabIndex : null, fields.level || null, J(progress)]);
  return progress;
}

/* ---------------- Kuis (bentuk data) ---------------- */
function validateQuestion(qn) {
  if (!qn || typeof qn !== "object") return null;
  const type = ["mcq", "short", "essay"].includes(qn.type) ? qn.type : null;
  if (!type) return null;
  const question = str(qn.question, 3000);
  if (!question) return null;
  const out = { id: str(qn.id, 40) || ("q_" + crypto.randomBytes(4).toString("hex")), type, question, modelAnswer: str(qn.modelAnswer, 3000) };
  if (type === "mcq") {
    let opts = Array.isArray(qn.options) ? qn.options.map(o => str(o, 500)) : [];
    while (opts.length < 4) opts.push("");
    out.options = opts.slice(0, 4);
    let c = parseInt(qn.correct, 10);
    out.correct = isNaN(c) || c < 0 || c > 3 ? 0 : c;
  }
  return out;
}
function publicQuiz(quiz) {
  if (!quiz) return null;
  return {
    active: !!quiz.active, id: quiz.id, topicId: quiz.topic_id || quiz.topicId, publishedAt: quiz.published_at || quiz.publishedAt,
    questions: (quiz.questions || []).map(x => {
      const o = { id: x.id, type: x.type, question: x.question };
      if (x.type === "mcq") o.options = x.options || [];
      return o;
    })
  };
}
function fullQuiz(r) {
  if (!r) return null;
  return { active: !!r.active, id: r.id, topicId: r.topic_id, questions: r.questions || [], publishedAt: r.published_at, endedAt: r.ended_at };
}
async function latestQuiz() {
  return one(`select * from ps_quizzes order by published_at desc limit 1`);
}

/* ============================================================
   Handler per mode
   ============================================================ */
const H = {};

H.health = async () => {
  await q(`select 1 as ok`);
  return { ok: true, ai: aiConfigured(), teacher: teacherConfigured(), selfStudy: !!String(process.env.SELF_STUDY_CODE || "").trim(), explore: !!exploreCode(), models: MODELS };
};

// Gerbang siswa: kode sesi kelas, kode belajar mandiri, atau kode eksplorasi.
H.verify_access = async (b) => {
  const code = str(b.code, 80);
  const sid = sidOf(b);
  if (!code) throw new HttpError(400, isEn(b) ? "Enter a code first." : "Masukkan kode dulu.");
  const state = await readSession();
  let kind = null;
  if (codeMatches(state, code)) kind = "class";
  else if (matchExplore(code)) kind = "explore";
  else if (matchSelfStudy(code)) kind = "self";
  if (!kind) throw new HttpError(403, isEn(b) ? "That code is not valid. Ask your teacher for the class session code or the self-study code." : "Kode tidak valid. Minta kode sesi kelas atau kode belajar mandiri ke gurumu.");
  let progress = {};
  if (sid) progress = await touchStudent(sid, { sessionCode: kind === "class" ? state.code : null, progress: b.progress });
  return { ok: true, kind, token: issueToken(kind), session: kind === "class" ? state : null, progress };
};

H.session_sync = async (b) => {
  const state = await readSession();
  const code = str(b.code, 20);
  const sid = sidOf(b);
  const inSession = codeMatches(state, code);
  let progress = null;
  if (sid) {
    progress = await touchStudent(sid, {
      sessionCode: inSession ? state.code : null,
      topicId: topicOf(b) || null,
      tabIndex: typeof b.tabIndex === "number" ? b.tabIndex : null,
      level: lvl(b.level),
      progress: b.progress
    });
  }
  const resp = { ...state, inSession, progress, serverNow: now() };
  const quiz = state.active ? await one(`select * from ps_quizzes where active = true order by published_at desc limit 1`) : null;
  if (quiz) {
    const pq = publicQuiz(quiz);
    if (sid) pq.submitted = !!(await one(`select 1 from ps_quiz_answers where quiz_id = $1 and student_id = $2`, [quiz.id, sid]));
    resp.activeQuiz = pq;
  } else {
    resp.activeQuiz = null;
  }
  return resp;
};

H.teacher_session = async (b) => {
  requireTeacher(b);
  const action = str(b.action, 20);
  let s = await readSession();
  const tab = typeof b.tabIndex === "number" ? b.tabIndex : 0;
  if (action === "start") {
    s = { active: true, code: generateSessionCode(), topicId: topicOf(b) || null, tabIndex: tab, updatedAt: now() };
  } else if (action === "update") {
    if (!s.active) throw new HttpError(409, isEn(b) ? "No active session - start one first." : "Belum ada sesi aktif - mulai sesi baru dulu.");
    s.topicId = topicOf(b) || null; s.tabIndex = tab; s.updatedAt = now();
  } else if (action === "end") {
    s.active = false; s.updatedAt = now();
    await q(`update ps_quizzes set active = false, ended_at = $1 where active = true`, [now()]);
  } else {
    throw new HttpError(400, "Unknown action: " + action);
  }
  await writeSession(s);
  return { state: s };
};

H.teacher_roster = async (b) => {
  requireTeacher(b);
  const state = await readSession();
  const since = now() - ROSTER_WINDOW_MS;
  const rows = await q(`select student_id, topic_id, tab_index, level, last_seen, session_code from ps_students where last_seen >= $1 order by last_seen desc limit 300`, [since]);
  const roster = {};
  rows.forEach(r => {
    roster[r.student_id] = {
      topicId: r.topic_id, tabIndex: r.tab_index == null ? null : Number(r.tab_index), level: r.level,
      lastSeen: r.last_seen, inSession: !!(state.active && r.session_code && r.session_code === state.code)
    };
  });
  const pend = await q(`select student_id, topic_id, stage, submitted_at, summary from ps_gates where status = 'pending' order by submitted_at asc limit 200`);
  const quiz = await latestQuiz();
  return {
    state, roster, serverNow: now(),
    gatePending: pend.map(r => ({ studentId: r.student_id, topicId: r.topic_id, stage: r.stage, submittedAt: r.submitted_at, summary: r.summary || "" })),
    activeQuiz: fullQuiz(quiz)
  };
};

/* ---------------- Gate (checkpoint guru PjBL) ---------------- */
H.gate_submit = async (b) => {
  const topicId = topicOf(b), sid = sidOf(b), stage = str(b.stage, 20);
  if (!topicId || !sid || !STAGES.includes(stage)) throw new HttpError(400, "Data konfirmasi tidak lengkap.");
  const summary = str(b.summary, 2000);
  await q(`insert into ps_gates (topic_id, student_id, stage, status, summary, note, submitted_at, decided_at)
           values ($1, $2, $3, 'pending', $4, '', $5, null)
           on conflict (topic_id, student_id, stage) do update set status = 'pending', summary = excluded.summary,
             note = '', submitted_at = excluded.submitted_at, decided_at = null`,
    [topicId, sid, stage, summary, now()]);
  await q(`insert into ps_events (student_id, topic_id, kind, item, payload, score, created_at) values ($1, $2, 'gate_submit', $3, $4::jsonb, null, $5)`,
    [sid, topicId, stage, J({ summary }), now()]);
  return { ok: true };
};

H.gate_status = async (b) => {
  const rows = await q(`select stage, status, note, summary, submitted_at, decided_at from ps_gates where topic_id = $1 and student_id = $2`, [topicOf(b), sidOf(b)]);
  const out = { eksperimen: null, lab: null };
  rows.forEach(r => { out[r.stage] = { status: r.status, note: r.note || "", summary: r.summary || "", submittedAt: r.submitted_at, decidedAt: r.decided_at }; });
  return out;
};

H.teacher_gate_decide = async (b) => {
  requireTeacher(b);
  const topicId = topicOf(b), sid = sidOf(b), stage = str(b.stage, 20), decision = str(b.decision, 20);
  if (!topicId || !sid || !STAGES.includes(stage) || !["approved", "rejected"].includes(decision)) throw new HttpError(400, "Data keputusan tidak lengkap.");
  const rows = await q(`update ps_gates set status = $4, note = $5, decided_at = $6
                        where topic_id = $1 and student_id = $2 and stage = $3 and status = 'pending' returning stage`,
    [topicId, sid, stage, decision, str(b.note, 500), now()]);
  if (!rows.length) throw new HttpError(404, isEn(b) ? "Request not found or already decided." : "Permintaan tidak ditemukan atau sudah diproses.");
  return { ok: true };
};

/* ---------------- Kuis Topik ---------------- */
H.quiz_bank_get = async (b) => {
  requireTeacher(b);
  const r = await one(`select questions from ps_quiz_bank where topic_id = $1`, [topicOf(b)]);
  return { questions: r ? r.questions || [] : [] };
};

H.quiz_bank_save = async (b) => {
  requireTeacher(b);
  const topicId = topicOf(b);
  if (!topicId) throw new HttpError(400, "topicId wajib diisi.");
  const raw = Array.isArray(b.questions) ? b.questions : [];
  if (raw.length > 100) throw new HttpError(400, "Maksimal 100 soal per bank topik.");
  const questions = raw.map(validateQuestion).filter(Boolean);
  await q(`insert into ps_quiz_bank (topic_id, questions, updated_at) values ($1, $2::jsonb, $3)
           on conflict (topic_id) do update set questions = excluded.questions, updated_at = excluded.updated_at`, [topicId, J(questions), now()]);
  return { ok: true, questions };
};

H.quiz_publish = async (b) => {
  requireTeacher(b);
  const state = await readSession();
  if (!state.active) throw new HttpError(409, isEn(b) ? "No active class session. Start one first, then publish the quiz." : "Belum ada sesi kelas aktif. Mulai sesi kelas dulu, baru publikasikan kuis.");
  const raw = Array.isArray(b.questions) ? b.questions : [];
  if (!raw.length) throw new HttpError(400, isEn(b) ? "Select at least one question." : "Pilih minimal 1 soal.");
  if (raw.length > 40) throw new HttpError(400, "Maksimal 40 soal per kuis.");
  const questions = raw.map(validateQuestion).filter(Boolean);
  if (!questions.length) throw new HttpError(400, "Soal yang dipilih tidak valid.");
  // Kuis lama TIDAK dihapus lagi (beda dengan V7): hanya dinonaktifkan, jadi
  // jawaban siswa tetap tersimpan sebagai arsip untuk rekap & ekspor.
  await q(`update ps_quizzes set active = false, ended_at = $1 where active = true`, [now()]);
  const id = "quiz_" + now().toString(36) + crypto.randomBytes(2).toString("hex");
  await q(`insert into ps_quizzes (id, topic_id, questions, active, published_at) values ($1, $2, $3::jsonb, true, $4)`, [id, topicOf(b), J(questions), now()]);
  return { quiz: fullQuiz(await one(`select * from ps_quizzes where id = $1`, [id])) };
};

H.quiz_unpublish = async (b) => {
  requireTeacher(b);
  await q(`update ps_quizzes set active = false, ended_at = $1 where active = true`, [now()]);
  return { ok: true };
};

H.quiz_list = async (b) => {
  requireTeacher(b);
  const rows = await q(`select z.id, z.topic_id, z.active, z.published_at, z.ended_at, jsonb_array_length(z.questions) as n,
                          (select count(*) from ps_quiz_answers a where a.quiz_id = z.id) as answers
                        from ps_quizzes z order by z.published_at desc limit 100`);
  return { quizzes: rows.map(r => ({ id: r.id, topicId: r.topic_id, active: !!r.active, publishedAt: r.published_at, endedAt: r.ended_at, count: Number(r.n), answers: Number(r.answers) })) };
};

H.quiz_results = async (b) => {
  requireTeacher(b);
  const quiz = b.quizId ? await one(`select * from ps_quizzes where id = $1`, [str(b.quizId, 60)]) : await latestQuiz();
  if (!quiz) return { quiz: null, answers: [] };
  const answers = await q(`select student_id, answers, score, submitted_at from ps_quiz_answers where quiz_id = $1 order by submitted_at asc`, [quiz.id]);
  return { quiz: fullQuiz(quiz), answers: answers.map(a => ({ studentId: a.student_id, answers: a.answers || {}, score: a.score, submittedAt: a.submitted_at })) };
};

H.quiz_submit = async (b) => {
  const sid = sidOf(b);
  if (!sid) throw new HttpError(400, "Identitas siswa tidak ditemukan.");
  const state = await readSession();
  if (!codeMatches(state, b.code)) throw new HttpError(409, isEn(b) ? "The class session is no longer active." : "Sesi kelas sudah tidak aktif, jawaban tidak bisa dikirim.");
  const quiz = await one(`select * from ps_quizzes where id = $1`, [str(b.quizId, 60)]);
  if (!quiz || !quiz.active) throw new HttpError(409, isEn(b) ? "This quiz has ended." : "Kuis ini sudah tidak aktif (diakhiri/diganti guru).");
  const raw = b.answers && typeof b.answers === "object" ? b.answers : {};
  const clean = {};
  let mcq = 0, right = 0;
  (quiz.questions || []).forEach(qn => {
    if (qn.type === "mcq") mcq++;
    if (!(qn.id in raw)) return;
    if (qn.type === "mcq") {
      const i = parseInt(raw[qn.id], 10);
      clean[qn.id] = isNaN(i) || i < 0 || i > 3 ? null : i;
      if (clean[qn.id] === qn.correct) right++;
    } else {
      clean[qn.id] = str(raw[qn.id], qn.type === "essay" ? 4000 : 800);
    }
  });
  const score = mcq ? Math.round((right / mcq) * 1000) / 10 : null;
  await q(`insert into ps_quiz_answers (quiz_id, student_id, answers, score, submitted_at) values ($1, $2, $3::jsonb, $4, $5)
           on conflict (quiz_id, student_id) do update set answers = excluded.answers, score = excluded.score, submitted_at = excluded.submitted_at`,
    [quiz.id, sid, J(clean), score, now()]);
  return { ok: true, submittedAt: now() };
};

H.quiz_generate = async (b) => {
  requireTeacher(b);
  if (!aiConfigured()) throw new HttpError(503, "ANTHROPIC_API_KEY belum diatur di server.");
  const lang = isEn(b) ? "en" : "id";
  const topicTitle = str(b.topicTitle, 200);
  if (!topicTitle) throw new HttpError(400, "Topik wajib diisi.");
  let count = parseInt(b.count, 10);
  if (isNaN(count) || count < 1) count = 5;
  count = Math.min(count, 10);
  const qType = ["mcq", "short", "essay", "mixed"].includes(b.questionType) ? b.questionType : "mcq";
  const quota = await takeQuota("quiz", "teacher");
  if (!quota.ok) throw new HttpError(429, lang === "en" ? "Daily quiz-generation limit reached." : "Batas generate kuis hari ini sudah tercapai.");
  const prompt = buildQuizPrompt({
    topicTitle, formulaRef: str(b.formulaRef, 6000),
    existing: (Array.isArray(b.existingQuestions) ? b.existingQuestions : []).slice(0, 40).map(s => str(s, 300)),
    qType, count, lang, difficulty: lvl(b.difficulty)
  });
  let res;
  try {
    res = await createMessage({
      model: MODELS.chat, max_tokens: 12000,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }]
    });
  } catch (e) {
    await quota.release();
    throw new HttpError(502, describeAiError(e, lang));
  }
  const parsed = extractJson(res.text);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.questions) ? parsed.questions : []);
  const questions = arr.map(validateQuestion).filter(Boolean).slice(0, count);
  if (!questions.length) throw new HttpError(502, lang === "en" ? "The AI returned no usable questions, try again." : "AI tidak mengembalikan soal yang bisa dipakai, coba lagi.");
  const out = { questions };
  if (res.stopReason === "max_tokens") out.warning = lang === "en" ? "Output may be truncated." : "Output mungkin terpotong.";
  return out;
};

/* ---------------- Rekam jawaban & aktivitas ---------------- */
H.record_event = async (b) => {
  const sid = sidOf(b);
  const kind = str(b.kind, 40);
  if (!sid || !EVENT_KINDS.includes(kind)) throw new HttpError(400, "Data aktivitas tidak valid.");
  if (isGuestId(sid)) return { ok: true, skipped: true };
  const payload = b.payload === undefined ? null : b.payload;
  const json = J(payload);
  if (jsonSize(payload) > 60000) throw new HttpError(413, "Data aktivitas terlalu besar.");
  const score = typeof b.score === "number" && isFinite(b.score) ? b.score : null;
  await q(`insert into ps_events (student_id, topic_id, kind, item, payload, score, created_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [sid, topicOf(b) || null, kind, str(b.item, 120) || null, json, score, now()]);
  return { ok: true };
};

H.lkpd_save = async (b) => {
  const sid = sidOf(b), topicId = topicOf(b), mode = str(b.lkpdMode, 30);
  if (!sid || !topicId || !mode) throw new HttpError(400, "Data LKPD tidak lengkap.");
  if (isGuestId(sid)) return { ok: true, skipped: true };
  const json = J(b.data && typeof b.data === "object" ? b.data : {});
  if (jsonSize(json) > 200000) throw new HttpError(413, "Isi LKPD terlalu besar.");
  const progress = Math.max(0, Math.min(100, Number(b.progress) || 0));
  const score = typeof b.score === "number" && isFinite(b.score) ? b.score : null;
  const submit = !!b.submit;
  await q(`insert into ps_lkpd (student_id, topic_id, mode, data, progress, score, status, updated_at, submitted_at)
           values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
           on conflict (student_id, topic_id, mode) do update set data = excluded.data, progress = excluded.progress,
             score = excluded.score, updated_at = excluded.updated_at,
             status = case when excluded.status = 'submitted' then 'submitted' else ps_lkpd.status end,
             submitted_at = coalesce(excluded.submitted_at, ps_lkpd.submitted_at)`,
    [sid, topicId, mode, json, progress, score, submit ? "submitted" : "draft", now(), submit ? now() : null]);
  return { ok: true, savedAt: now(), status: submit ? "submitted" : undefined };
};

H.lkpd_get = async (b) => {
  const rows = await q(`select mode, data, progress, score, status, updated_at, submitted_at from ps_lkpd where student_id = $1 and topic_id = $2`, [sidOf(b), topicOf(b)]);
  const modes = {};
  rows.forEach(r => { modes[r.mode] = { data: r.data || {}, progress: r.progress, score: r.score, status: r.status, updatedAt: r.updated_at, submittedAt: r.submitted_at }; });
  return { modes };
};

H.eksperimen_data_save = async (b) => {
  const sid = sidOf(b), topicId = topicOf(b);
  const lang = isEn(b) ? "en" : "id";
  if (!sid) throw new HttpError(400, lang === "en" ? "Student identity not found." : "Identitas siswa tidak ditemukan.");
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 30).map(r => ({
    I: r && r.I != null && isFinite(Number(r.I)) ? Number(r.I) : null,
    values: (Array.isArray(r && r.values) ? r.values : []).slice(0, 8).map(v => (v === null || v === "" || !isFinite(Number(v))) ? null : Number(v))
  }));
  if (!rows.some(r => r.values.some(v => v !== null))) throw new HttpError(400, lang === "en" ? "No observation data to save." : "Tidak ada data pengamatan untuk disimpan.");
  const variant = str(b.variant, 30) || "default";
  const meta = b.meta && typeof b.meta === "object" ? b.meta : null;
  const analysis = b.analysis && typeof b.analysis === "object" ? b.analysis : null;

  let feedback = lang === "en" ? "Data saved." : "Data tersimpan.", flagged = false;
  if (aiConfigured()) {
    const quota = await takeQuota("datacheck", sid);
    if (quota.ok) {
      const rowsText = rows.map(r => `I=${r.I} A -> ${r.values.map(v => v === null ? "-" : v).join(", ")}`).join("\n");
      try {
        const res = await createMessage({
          model: MODELS.chat, max_tokens: 500,
          output_config: { effort: "low" }, thinking: { type: "disabled" },
          messages: [{ role: "user", content: buildDataCheckPrompt({ context: str(b.context, 2500), rowsText, lang }) }]
        }, { attempts: 2 });
        const p = extractJson(res.text);
        if (p && typeof p === "object") {
          feedback = str(p.feedback, 900) || feedback;
          flagged = !!p.flagged;
        }
      } catch (e) {
        await quota.release();
        feedback += " " + (lang === "en" ? "(The AI check is unavailable right now.)" : "(Pemeriksaan AI sedang tidak tersedia.)");
      }
    }
  }
  if (isGuestId(sid)) return { ok: true, feedback, flagged, savedAt: now() };
  await q(`insert into ps_experiment (student_id, topic_id, variant, rows, meta, analysis, feedback, flagged, updated_at)
           values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
           on conflict (student_id, topic_id, variant) do update set rows = excluded.rows, meta = excluded.meta,
             analysis = coalesce(excluded.analysis, ps_experiment.analysis), feedback = excluded.feedback,
             flagged = excluded.flagged, updated_at = excluded.updated_at`,
    [sid, topicId, variant, J(rows), J(meta), analysis ? J(analysis) : null, feedback, flagged, now()]);
  return { ok: true, feedback, flagged, savedAt: now() };
};

/* ---------------- Panel Guru: rekap & ekspor ---------------- */
H.teacher_overview = async (b) => {
  requireTeacher(b);
  const students = await q(`select student_id, name, class_name, created_at, last_seen, topic_id, tab_index, level, progress, session_code from ps_students order by class_name asc, name asc limit 1000`);
  const events = await q(`select student_id, kind, count(*) as n, max(score) as best, max(created_at) as last from ps_events group by student_id, kind`);
  const lastScore = await q(`select distinct on (student_id, kind) student_id, kind, score from ps_events where score is not null order by student_id, kind, created_at desc`);
  const lkpd = await q(`select student_id, topic_id, mode, progress, score, status, updated_at, submitted_at from ps_lkpd`);
  const gates = await q(`select student_id, topic_id, stage, status, submitted_at, decided_at from ps_gates`);
  const quizzes = await q(`select a.student_id, a.quiz_id, a.score, a.submitted_at, z.topic_id from ps_quiz_answers a join ps_quizzes z on z.id = a.quiz_id`);
  const exp = await q(`select student_id, topic_id, variant, updated_at, flagged, analysis from ps_experiment`);
  // Latihan: hasil percobaan PERTAMA per soal (indikator penguasaan, bukan hasil setelah melihat pembahasan)
  const lat = await q(`select student_id, item, (array_agg(score order by created_at asc))[1] as first_score
                       from ps_events where kind = 'latihan' and score is not null group by student_id, item`);
  return {
    serverNow: now(),
    latihanFirst: lat.map(r => ({ studentId: r.student_id, item: r.item, firstScore: r.first_score })),
    students: students.map(s => ({ studentId: s.student_id, name: s.name, className: s.class_name, createdAt: s.created_at, lastSeen: s.last_seen, topicId: s.topic_id, tabIndex: s.tab_index, level: s.level, progress: s.progress || {} })),
    events: events.map(e => ({ studentId: e.student_id, kind: e.kind, n: Number(e.n), best: e.best, last: e.last })),
    lastScores: lastScore.map(e => ({ studentId: e.student_id, kind: e.kind, score: e.score })),
    lkpd: lkpd.map(l => ({ studentId: l.student_id, topicId: l.topic_id, mode: l.mode, progress: l.progress, score: l.score, status: l.status, updatedAt: l.updated_at, submittedAt: l.submitted_at })),
    gates: gates.map(g => ({ studentId: g.student_id, topicId: g.topic_id, stage: g.stage, status: g.status, submittedAt: g.submitted_at, decidedAt: g.decided_at })),
    quizAnswers: quizzes.map(a => ({ studentId: a.student_id, quizId: a.quiz_id, topicId: a.topic_id, score: a.score, submittedAt: a.submitted_at })),
    experiments: exp.map(x => ({ studentId: x.student_id, topicId: x.topic_id, variant: x.variant, updatedAt: x.updated_at, flagged: x.flagged, analysis: x.analysis }))
  };
};

async function studentFull(sid) {
  const s = await one(`select * from ps_students where student_id = $1`, [sid]);
  const events = await q(`select topic_id, kind, item, payload, score, created_at from ps_events where student_id = $1 order by created_at asc limit 5000`, [sid]);
  const lkpd = await q(`select topic_id, mode, data, progress, score, status, updated_at, submitted_at from ps_lkpd where student_id = $1`, [sid]);
  const exp = await q(`select topic_id, variant, rows, meta, analysis, feedback, flagged, updated_at from ps_experiment where student_id = $1`, [sid]);
  const gates = await q(`select topic_id, stage, status, summary, note, submitted_at, decided_at from ps_gates where student_id = $1`, [sid]);
  const quiz = await q(`select a.quiz_id, a.answers, a.score, a.submitted_at, z.topic_id, z.questions from ps_quiz_answers a join ps_quizzes z on z.id = a.quiz_id where a.student_id = $1 order by a.submitted_at asc`, [sid]);
  return {
    student: s ? { studentId: s.student_id, name: s.name, className: s.class_name, createdAt: s.created_at, lastSeen: s.last_seen, topicId: s.topic_id, tabIndex: s.tab_index, level: s.level, progress: s.progress || {} } : null,
    events: events.map(e => ({ topicId: e.topic_id, kind: e.kind, item: e.item, payload: e.payload, score: e.score, createdAt: e.created_at })),
    lkpd: lkpd.map(l => ({ topicId: l.topic_id, mode: l.mode, data: l.data, progress: l.progress, score: l.score, status: l.status, updatedAt: l.updated_at, submittedAt: l.submitted_at })),
    experiments: exp.map(x => ({ topicId: x.topic_id, variant: x.variant, rows: x.rows, meta: x.meta, analysis: x.analysis, feedback: x.feedback, flagged: x.flagged, updatedAt: x.updated_at })),
    gates: gates.map(g => ({ topicId: g.topic_id, stage: g.stage, status: g.status, summary: g.summary, note: g.note, submittedAt: g.submitted_at, decidedAt: g.decided_at })),
    quizzes: quiz.map(a => ({ quizId: a.quiz_id, topicId: a.topic_id, answers: a.answers, score: a.score, submittedAt: a.submitted_at, questions: a.questions }))
  };
}

H.teacher_student_detail = async (b) => {
  requireTeacher(b);
  const sid = sidOf(b);
  if (!sid) throw new HttpError(400, "studentId wajib.");
  return studentFull(sid);
};

H.teacher_export = async (b) => {
  requireTeacher(b);
  const ids = Array.isArray(b.studentIds) && b.studentIds.length
    ? b.studentIds.slice(0, 400).map(s => str(s, MAX_SID))
    : (await q(`select student_id from ps_students order by class_name, name limit 400`)).map(r => r.student_id);
  const out = [];
  for (const sid of ids) out.push(await studentFull(sid));
  const quizzes = await q(`select id, topic_id, questions, published_at from ps_quizzes order by published_at asc`);
  return { exportedAt: now(), students: out, quizzes: quizzes.map(z => ({ id: z.id, topicId: z.topic_id, questions: z.questions, publishedAt: z.published_at })) };
};

H.teacher_delete_student = async (b) => {
  requireTeacher(b);
  const sid = sidOf(b);
  if (!sid) throw new HttpError(400, "studentId wajib.");
  for (const t of ["ps_events", "ps_lkpd", "ps_experiment", "ps_gates", "ps_quiz_answers", "ps_students"]) {
    await q(`delete from ${t} where student_id = $1`, [sid]);
  }
  return { ok: true };
};

H.teacher_usage = async (b) => {
  requireTeacher(b);
  return { today: await usageToday(), limits: limits(), ai: aiConfigured(), models: MODELS };
};

export async function dispatch(body) {
  const mode = str(body.mode, 40);
  const fn = H[mode];
  if (!fn) throw new HttpError(400, "Mode tidak dikenal: " + mode);
  return fn(body);
}

export { verifyToken };
