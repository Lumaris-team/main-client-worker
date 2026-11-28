// Learning AI — course generation, flashcards, activities & feedback.
// Backed by `subjects_data` (chapters + generation_jobs) and Workers AI.

import { callModel } from "../ai/core.js";
import { ensureChapterColumns } from "../database/subjects.js";

const MODEL = "@cf/openai/gpt-oss-120b";
const FALLBACK_MODEL = "@cf/openai/gpt-oss-20b";
// Fast model for remarks, corrections and Q&A — OSS 120B is reserved for
// initial lesson / training / test generation.
const FAST_MODEL = "@cf/meta/llama-3.2-3b-instruct";

const COMPONENTS = [
  "ShortTextInput", "LongTextInput", "NumberInput", "MathInput", "CodeInput",
  "SingleChoice", "MultipleChoice", "TrueFalse", "FillBlanks", "MatchingPairs",
  "DragSort", "CategorySort", "ImageLabeling", "HotspotSelection", "GraphPlotter",
  "DiagramBuilder", "TimelineBuilder", "AudioRecorder", "AudioPlayer",
  "DrawingBoard", "Flashcard", "ProofBuilder", "TableCompletion", "OrderingExercise",
  "ErrorCorrection",
];

// ---------- helpers ----------

async function ai(env, prompt, maxTokens = 4000) {
  let res = await callModel(env, MODEL, prompt, { maxTokens });
  if (!res?.ok) res = await callModel(env, FALLBACK_MODEL, prompt, { maxTokens });
  if (!res?.ok) throw new Error(res?.error || "AI request failed");
  return res.response || "";
}

async function fastAI(env, prompt, maxTokens = 1500) {
  const res = await callModel(env, FAST_MODEL, prompt, { maxTokens });
  if (!res?.ok) {
    // Fall back to the small OSS model if the fast one is unavailable
    const alt = await callModel(env, FALLBACK_MODEL, prompt, { maxTokens });
    if (!alt?.ok) throw new Error(alt?.error || res?.error || "AI request failed");
    return alt.response || "";
  }
  return res.response || "";
}

function extractJSON(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function chapterSource(ch) {
  return [
    ch.teacher_notes && `=== TEACHER NOTES (how the teacher tests & her expectations) ===\n${ch.teacher_notes}`,
    ch.raw_lessons && `=== RAW LESSONS ===\n${ch.raw_lessons}`,
    ch.raw_recorded_lessons && `=== RECORDED LESSONS ===\n${ch.raw_recorded_lessons}`,
    ch.body && `=== EXISTING COURSE ===\n${ch.body}`,
  ].filter(Boolean).join("\n\n") || "";
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "\n[…truncated…]";
}

async function getChapter(env, lessonId) {
  return env.subjects_data.prepare("SELECT * FROM chapters WHERE lesson_id = ?").bind(Number(lessonId)).first();
}

async function getSubject(env, subjectId) {
  if (subjectId === undefined || subjectId === null || subjectId === "") return null;
  return env.subjects_data.prepare("SELECT * FROM subjects WHERE subject_id = ?").bind(Number(subjectId)).first();
}

async function updateChapter(env, lessonId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await env.subjects_data.prepare(
    `UPDATE chapters SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE lesson_id = ?`
  ).bind(...keys.map((k) => fields[k]), Number(lessonId)).run();
}

async function getJob(env, jobId) {
  return env.subjects_data.prepare("SELECT * FROM generation_jobs WHERE job_id = ?").bind(Number(jobId)).first();
}

async function saveJob(env, jobId, fields) {
  const keys = Object.keys(fields);
  await env.subjects_data.prepare(
    `UPDATE generation_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE job_id = ?`
  ).bind(...keys.map((k) => fields[k]), new Date().toISOString(), Number(jobId)).run();
}

async function latestCourseJob(env, lessonId) {
  return env.subjects_data.prepare(
    "SELECT * FROM generation_jobs WHERE lesson_id = ? AND kind = 'course' ORDER BY job_id DESC LIMIT 1"
  ).bind(Number(lessonId)).first();
}

function sliceForSection(source, index, total) {
  if (!source) return "";
  const size = Math.ceil(source.length / Math.max(total, 1));
  const start = index * size;
  const end = index === total - 1 ? source.length : start + size;
  return source.slice(start, end);
}

// ---------- actions ----------

async function coursePlan(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const source = truncate(chapterSource(ch), 45000);
  if (!source.trim()) throw new Error("No raw content to generate from — import a lesson first");

  const prompt = `You are an expert curriculum designer. Below is the RAW source material for a school chapter (it may be messy OCR/notes — extract ALL information, miss nothing important).

Produce a detailed course outline as STRICT JSON only (no markdown, no commentary):
{"title": "<chapter title>", "sections": [{"title": "...", "goal": "what this section teaches", "key_points": ["...", "..."]}]}

Rules:
- 6 to 14 sections, ordered pedagogically (foundations → core → applications → synthesis).
- Each section must cover a distinct part of the source; together they must cover EVERYTHING.
- Respond with the JSON object only.`;

  const raw = await ai(env, `${prompt}\n\n=== SOURCE ===\n${source}`, 3000);
  const parsed = extractJSON(raw);
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : null;
  if (!sections?.length) throw new Error("AI did not return a valid outline");

  // Reuse an unfinished course job if present, else create one.
  const existing = await latestCourseJob(env, body.lesson_id);
  const payload = JSON.stringify({ outline: sections, done: sections.map(() => false), source_len: source.length });
  let jobId;
  if (existing && existing.status !== "done") {
    jobId = existing.job_id;
    await saveJob(env, jobId, { status: "planned", payload });
  } else {
    const idRow = await env.subjects_data.prepare(
      "SELECT COALESCE(MAX(job_id), 0) + 1 AS id FROM generation_jobs"
    ).first();
    jobId = Number(idRow?.id) || 1;
    await env.subjects_data.prepare(
      "INSERT INTO generation_jobs (job_id, lesson_id, kind, status, payload, created_at, updated_at) VALUES (?, ?, 'course', 'planned', ?, ?, ?)"
    ).bind(jobId, Number(body.lesson_id), payload, new Date().toISOString(), new Date().toISOString()).run();
  }
  return { job_id: jobId, outline: sections };
}

async function courseSection(env, body) {
  const job = await getJob(env, body?.job_id);
  if (!job || job.kind !== "course") throw new Error("Course job not found");
  const payload = JSON.parse(job.payload || "{}");
  const sections = payload.outline || [];
  const i = Number(body?.index);
  if (!Number.isInteger(i) || i < 0 || i >= sections.length) throw new Error("Invalid section index");
  if (payload.done?.[i]) return { section: i, done: true, progress: progressOf(payload) };

  const ch = await getChapter(env, job.lesson_id);
  const source = chapterSource(ch);
  const excerpt = truncate(sliceForSection(source, i, sections.length), 30000);
  const prev = i > 0 ? sections[i - 1].title : "";

  const prompt = `You are writing a complete, exhaustive school course in markdown. This is section ${i + 1}/${sections.length}: "${sections[i].title}".
Goal: ${sections[i].goal || "cover the topic thoroughly"}.
Key points to cover: ${(sections[i].key_points || []).join("; ") || "all relevant content"}.
${prev ? `Previous section was: "${prev}" — continue coherently without repeating it.` : "This is the opening section — include a short intro and learning objectives."}

ABSOLUTE RULES:
- Write in the same language as the source material.
- DO NOT omit any detail present in the source excerpt: definitions, formulas, dates, names, examples, exceptions, remarks.
- Use markdown: ## headings, lists, tables, LaTeX ($...$) for math, code blocks for code.
- Be thorough and pedagogically structured (explanations, examples, analogies where useful).
- Output ONLY the section content in markdown (start with a ## heading). No preamble.`;

  const content = await ai(env, `${prompt}\n\n=== SOURCE EXCERPT ===\n${excerpt || source}`, 6000);
  if (!content.trim()) throw new Error("AI returned an empty section");

  // The model is asked to start with a ## heading AND we prepend one — strip
  // the leading heading from the content to avoid a duplicated title.
  const text = content.trim().replace(/^#{1,4}\s+[^\n]*\n+/, "");
  const header = `\n\n## ${sections[i].title}\n\n`;
  const newBody = (ch.body || "") + header + text + "\n";
  await updateChapter(env, job.lesson_id, { body: newBody });

  payload.done[i] = true;
  const allDone = payload.done.every(Boolean);
  await saveJob(env, job.job_id, {
    status: allDone ? "done" : "running",
    payload: JSON.stringify(payload),
  });
  return { section: i, done: true, progress: progressOf(payload), status: allDone ? "done" : "running" };
}

function progressOf(payload) {
  const done = (payload.done || []).filter(Boolean).length;
  const total = (payload.done || []).length;
  return { done, total };
}

async function courseStatus(env, body) {
  const jobId = body?.job_id;
  const lessonId = body?.lesson_id;
  let job = jobId ? await getJob(env, jobId) : await latestCourseJob(env, lessonId);
  if (!job) return { job: null };
  const payload = JSON.parse(job.payload || "{}");
  return { job: { ...job, payload }, progress: progressOf(payload) };
}

async function flashcards(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const source = truncate(chapterSource(ch), 40000);
  if (!source.trim()) throw new Error("No content to make flashcards from");

  // Optional focus: generate cards ONLY around weak notions (lacunes).
  const focus = String(body?.focus || "").trim().slice(0, 2000);
  const focusBlock = focus ? `\nPRIORITY TARGET — the student is weak on these notions, EVERY card must cover them: ${focus}\n` : "";
  const prompt = `You are an expert flashcard designer. From the course material below, create EVERY flashcard needed to memorize it — miss nothing: definitions, formulas, dates, names, mechanisms, comparisons, exceptions.${focusBlock}

Respond with STRICT JSON only:
{"flashcards": [{"front": "question or cloze (use ___ for hidden parts)", "back": "complete answer", "tags": ["topic"], "difficulty": "easy|medium|hard", "kind": "qa|cloze|reverse|formula|concept"}]}

Rules:
- Cover ALL sections and ALL key facts of the source.
- Vary kinds: question/answer, cloze deletion, reversed (definition → term), formulas, comprehension ("why is X true?").
- At least 15 cards; more if the source is rich. No duplicates.
- JSON only, no markdown.`;

  const raw = await ai(env, `${prompt}\n\n=== COURSE ===\n${source}`, 8000);
  const parsed = extractJSON(raw);
  const cards = Array.isArray(parsed?.flashcards) ? parsed.flashcards : (Array.isArray(parsed) ? parsed : null);
  if (!cards?.length) throw new Error("AI did not return valid flashcards");

  // append=true → merge into existing cards (dedup by front) instead of replacing.
  if (body?.append) {
    let existing = [];
    try {
      const prev = typeof ch.flashcards === "string" ? JSON.parse(ch.flashcards) : ch.flashcards;
      if (Array.isArray(prev?.cards)) existing = prev.cards;
    } catch {}
    const seen = new Set(existing.map((c) => String(c?.front || "").trim().toLowerCase()).filter(Boolean));
    const fresh = cards.filter((c) => {
      const k = String(c?.front || "").trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const merged = [...existing, ...fresh];
    await updateChapter(env, body.lesson_id, { flashcards: JSON.stringify({ cards: merged, generated_at: new Date().toISOString() }) });
    return { count: merged.length, added: fresh.length };
  }

  await updateChapter(env, body.lesson_id, { flashcards: JSON.stringify({ cards, generated_at: new Date().toISOString() }) });
  return { count: cards.length };
}

// ---------- spaced repetition: SM-2 scheduling per card ----------
// Each card carries ease/interval/due/reps/lapses (like Anki). Cards without
// schedule fields are treated as due today — the first smart session reviews
// the whole deck, then only what is actually due comes back.

const DAY_MS = 86400000;
function todayStr(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function parseFlashcards(ch) {
  try {
    const p = typeof ch.flashcards === "string" ? JSON.parse(ch.flashcards) : ch.flashcards;
    return Array.isArray(p?.cards) ? p.cards : [];
  } catch { return []; }
}

function cardSchedule(c) {
  return {
    ease: Number(c.ease) > 0 ? Number(c.ease) : 2.5,
    interval: Math.max(0, Number(c.interval) || 0),
    due: /^\d{4}-\d{2}-\d{2}$/.test(c.due || "") ? c.due : todayStr(0),
    reps: Math.max(0, Number(c.reps) || 0),
    lapses: Math.max(0, Number(c.lapses) || 0),
    last_q: Math.max(0, Number(c.last_q) || 0),
  };
}

// SM-2 quality 1-5 (Encore=1, Dur=3, Bien=4, Facile=5) → writes schedule fields.
function applyGrade(c, q) {
  const s = cardSchedule(c);
  q = Math.max(1, Math.min(5, Math.round(q)));
  if (q < 3) {
    s.reps = 0;
    s.interval = 1;
    s.lapses += 1;
  } else {
    s.reps += 1;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 6 : Math.max(1, Math.round(s.interval * s.ease));
    s.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  }
  s.last_q = q;
  s.due = todayStr(s.interval);
  Object.assign(c, {
    ease: +s.ease.toFixed(2), interval: s.interval, due: s.due,
    reps: s.reps, lapses: s.lapses, last_q: q,
  });
}

function cardStats(cards) {
  const t = todayStr(0);
  let due = 0, mature = 0, fresh = 0;
  for (const c of cards) {
    const s = cardSchedule(c);
    if (s.due <= t) due++;
    if (s.interval >= 21) mature++;
    if (!s.reps && !s.lapses && !s.last_q) fresh++;
  }
  return { total: cards.length, due, mature, fresh };
}

async function reviewStatus(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  return cardStats(parseFlashcards(ch));
}

async function reviewLog(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const cards = parseFlashcards(ch);
  if (!cards.length) throw new Error("No flashcards on this chapter");

  const byFront = new Map();
  for (const c of cards) {
    const k = String(c?.front || "").trim().toLowerCase();
    if (k && !byFront.has(k)) byFront.set(k, c);
  }

  // grades: [{front, q}] — later entries win for duplicate fronts.
  let updated = 0;
  for (const g of Array.isArray(body?.grades) ? body.grades : []) {
    const card = byFront.get(String(g?.front || "").trim().toLowerCase());
    const q = Number(g?.q);
    if (!card || !Number.isFinite(q)) continue;
    applyGrade(card, q);
    updated++;
  }

  if (updated) {
    const prev = typeof ch.flashcards === "string" ? JSON.parse(ch.flashcards) : (ch.flashcards || {});
    await updateChapter(env, ch.lesson_id, {
      flashcards: JSON.stringify({ ...prev, cards, reviewed_at: new Date().toISOString() }),
    });
  }
  return { ...cardStats(cards), updated };
}

const ACTIVITY_SPEC = `Each activity: {"id":"a1","component":"<one of: ${COMPONENTS.join(", ")}>","title":"...","instruction":"what the student must do","payload":{...component-specific data...},"answer":{...expected answer data...},"explanation":"why the answer is correct"}.
Component payload shapes:
- ShortTextInput/LongTextInput/NumberInput/MathInput/CodeInput: {"placeholder":"..."}; answer: {"text"|"number"|"expression"|"code": "..."}
- SingleChoice/MultipleChoice/TrueFalse: {"options":["..."]} or {"statement":"..."}; answer: {"index"|"indexes"|"value": ...}
- FillBlanks: {"text":"Sentence with ___ blanks"}; answer: {"blanks":["w1","w2"]}
- MatchingPairs: {"left":["..."],"right":["..."]}; answer: {"pairs":[[li,ri],...]}
- DragSort/OrderingExercise: {"items":["..."]}; answer: {"order":[indices in correct order]}
- CategorySort: {"items":["..."],"categories":["..."]}; answer: {"assignment":[catIndex per item]}
- ImageLabeling: {"image":"description or url","labels":["..."]}; answer: {"regions":[...]}
- HotspotSelection: {"image":"...","points":[{"x":0-1,"y":0-1,"label":"..."}]}; answer: {"selected":[pointIndexes]}
- GraphPlotter: {"xLabel":"...","yLabel":"...","points":[[x,y]],"expected":[[x,y]]}; answer: {"points":[[x,y]]}
- DiagramBuilder: {"nodes":["..."],"edges":[[from,to]]}; answer: {"edges":[[from,to]]}
- TimelineBuilder: {"events":[{"label":"...","date":"..."}]}; answer: {"order":[eventIndexes]}
- AudioRecorder: {"prompt":"...","maxSeconds":60}; answer: {"recorded":true}
- AudioPlayer: {"audio":"base64 or url","question":"..."}; answer: {"text":"..."}
- DrawingBoard: {"prompt":"...","reference":"description"}; answer: {"drawing":"dataURL or description"}
- Flashcard: {"front":"...","back":"..."}; answer: {"flipped":true}
- ProofBuilder: {"steps":["..."],"premises":["..."]}; answer: {"order":[stepIndexes]}
- TableCompletion: {"headers":["..."],"rows":[["...",null,...]]}; answer: {"cells":[[r,c,value],...]}
- ErrorCorrection: {"text":"text containing errors","errors":[{"wrong":"...","right":"..."}]}; answer: {"corrections":[{"wrong":"...","right":"..."}]}`;

async function activities(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const source = truncate(chapterSource(ch), 35000);
  if (!source.trim()) throw new Error("No content for activities");

  const count = Math.min(Math.max(Number(body?.count) || 8, 4), 20);
  const prompt = `You are an expert pedagogy engine. From the course material below, design ${count} learning activities that test understanding progressively (easy → hard), using VARIED component types chosen for each section's content.

${ACTIVITY_SPEC}

Respond with STRICT JSON only:
{"activities": [ ...${count} activity objects... ]}

Rules:
- Vary components — do not repeat the same type unless content demands it.
- Every activity must be answerable from the course content; answers must be exact and unambiguous.
- JSON only.`;

  const raw = await ai(env, `${prompt}\n\n=== COURSE ===\n${source}`, 8000);
  const parsed = extractJSON(raw);
  const list = Array.isArray(parsed?.activities) ? parsed.activities : null;
  if (!list?.length) throw new Error("AI did not return valid activities");

  const payload = { activities: list, generated_at: new Date().toISOString(), model: MODEL };
  await updateChapter(env, body.lesson_id, { tests: JSON.stringify(payload) });
  return { count: list.length, components: [...new Set(list.map((a) => a.component))] };
}

async function feedback(env, body) {
  const { component, instruction, expected, answer, context } = body || {};
  if (!component || expected === undefined) throw new Error("component and expected are required");

  const prompt = `You are a strict but encouraging tutor. A student answered a ${component} exercise.
${instruction ? `Instruction: ${instruction}` : ""}
Expected answer (JSON): ${JSON.stringify(expected)}
Student answer (JSON): ${JSON.stringify(answer ?? null)}
${context ? `Course context excerpt: ${truncate(String(context), 4000)}` : ""}

Decide if the answer is correct (allow equivalent formulations, minor formatting differences; be strict on facts/formulas).
Respond with STRICT JSON only:
{"correct": true|false, "score": 0-100, "comment": "short personalized remark in the same language as the exercise (1-3 sentences, explain the error or confirm mastery)", "hint": "one guiding hint if incorrect, else null"}`;

  const raw = await fastAI(env, prompt, 1200);
  const parsed = extractJSON(raw);
  return {
    correct: !!parsed?.correct,
    score: Number(parsed?.score) || (parsed?.correct ? 100 : 0),
    comment: parsed?.comment || (parsed?.correct ? "Correct!" : "Incorrect."),
    hint: parsed?.hint || null,
  };
}

async function ask(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const question = String(body?.question || "").trim();
  if (!question) throw new Error("question is required");

  const source = truncate(chapterSource(ch), 30000);
  const prompt = `You are a patient tutor. Answer the student's question using ONLY the course material below (supplement with general knowledge only when the material is silent, and say so).
Chapter: ${ch.lesson_name || "untitled"}${ch.lesson_description ? ` — ${ch.lesson_description}` : ""}

=== COURSE MATERIAL ===
${source || "(no course content yet)"}

Student question: ${question}

Answer in the same language as the question, concisely but completely (markdown allowed). If the course doesn't cover it, say so honestly.`;

  const answer = await fastAI(env, prompt, 2000);
  return { answer: answer.trim() || "No answer." };
}

async function aiComment(env, body) {
  let context = "";
  let label = "";

  if (body?.lesson_id) {
    const ch = await getChapter(env, body.lesson_id);
    if (!ch) throw new Error("Chapter not found");
    const subject = await getSubject(env, ch.subject_id);
    label = ch.lesson_name || "chapter";
    context = [
      subject?.subject_name && `Subject: ${subject.subject_name}`,
      `Chapter: ${ch.lesson_name || "untitled"}`,
      ch.lesson_description && `Description: ${ch.lesson_description}`,
      ch.teacher_notes && `Teacher notes (how she tests & expectations): ${ch.teacher_notes}`,
      subject?.teacher_notes && `Subject teacher notes: ${subject.teacher_notes}`,
      ch.tests_date && `Next test: ${ch.tests_date}`,
      ch.session_date && `Session date: ${ch.session_date}`,
      truncate(chapterSource(ch), 6000) && `Content excerpt:\n${truncate(chapterSource(ch), 6000)}`,
    ].filter(Boolean).join("\n");
  } else if (body?.subject_id) {
    const subject = await getSubject(env, body.subject_id);
    if (!subject) throw new Error("Subject not found");
    label = subject.subject_name || "subject";
    const { results: chapters } = await env.subjects_data.prepare(
      "SELECT lesson_name, lesson_description, teacher_notes FROM chapters WHERE subject_id = ? ORDER BY lesson_id LIMIT 30"
    ).bind(Number(body.subject_id)).all();
    const chList = (chapters || []).map((c) => `- ${c.lesson_name || "untitled"}${c.lesson_description ? `: ${c.lesson_description}` : ""}${c.teacher_notes ? ` (notes prof: ${c.teacher_notes})` : ""}`).join("\n");
    context = [
      `Subject: ${subject.subject_name || "untitled"}`,
      subject.comments && `Comments: ${subject.comments}`,
      subject.tests_comments && `Tests comments: ${subject.tests_comments}`,
      subject.teacher_notes && `Teacher notes (how she tests & expectations): ${subject.teacher_notes}`,
      chList && `Chapters:\n${chList}`,
    ].filter(Boolean).join("\n");
  } else {
    context = String(body?.context || "").trim();
    if (!context) throw new Error("context is required");
    label = "element";
  }

  const prompt = `You are a concise academic assistant. Write a short internal comment (2-4 sentences, markdown allowed) about "${label}" for a student dashboard.
Summarize what matters: current state, what to watch, suggested next step. Base it ONLY on the information below — if there is little information, say the element is still empty and what to add first.
Answer in French.

=== INFORMATION ===
${context}`;

  const comment = (await fastAI(env, prompt, 800)).trim();
  return { comment: comment || "Aucune information pour le moment — importez du contenu ou complétez les champs." };
}

async function testReport(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const subject = await getSubject(env, ch.subject_id);

  const pct = Number(body?.pct);
  const grade = body?.grade != null ? Number(body.grade) : null;
  const notation = body?.notation != null ? Number(body.notation) : null;
  const maxMin = Number(body?.max_minutes) || null;
  const elapsedMin = Number(body?.elapsed_minutes) || null;
  const correct = Number(body?.correct_count) || 0;
  const total = Number(body?.total_count) || 0;
  const answered = Number(body?.answered_count) || 0;

  if (!Number.isFinite(pct)) throw new Error("pct is required");

  const notes = [
    ch.teacher_notes && `Chapter teacher notes: ${ch.teacher_notes}`,
    subject?.teacher_notes && `Subject teacher notes: ${subject.teacher_notes}`,
  ].filter(Boolean).join("\n");

  const prompt = `You are a demanding but fair teacher writing end-of-test feedback.
Chapter: ${ch.lesson_name || "untitled"}${ch.lesson_description ? ` — ${ch.lesson_description}` : ""}
${subject?.subject_name ? `Subject: ${subject.subject_name}` : ""}
${notes ? `\n=== TEACHER EXPECTATIONS ===\n${notes}` : ""}

=== TEST RESULT ===
Score: ${pct.toFixed(1)}%${grade != null && notation != null ? ` — grade ${grade}/${notation}` : ""}
Exercises: ${correct}/${total} fully correct, ${answered}/${total} answered
${maxMin ? `Allowed duration: ${maxMin} min${elapsedMin != null ? ` — used ${elapsedMin.toFixed(1)} min` : ""}` : ""}

Write a short progression remark (3-5 sentences, markdown allowed) that:
- reacts to the score honestly (celebrate real progress, don't inflate);
- references the teacher's expectations when provided (what was expected vs what was shown);
- gives 2-3 concrete next steps to improve;
- mentions time management if a duration was set.
Answer in the same language as the teacher notes (French if they are in French, otherwise English).`;

  const remark = (await fastAI(env, prompt, 1200)).trim();
  return { remark: remark || "Keep practicing — review the weak points and try again.", pct, grade, notation };
}

// ---------- learn: all review methods (interactive tutoring + generators) ----------
// Method keys are shared with the frontend review menu (chapter-tools.js).
const LEARN_METHODS = {
  // Apprendre
  feynman: "You are running the Feynman technique. Ask the student to explain ONE notion from the course in their own simple words. Then identify what is imprecise or missing, ask a follow-up, and only give the correction once they have tried. One step at a time, in French, encouraging but rigorous.",
  guided: "You are a patient tutor teaching the course progressively, notion by notion. Present ONE small step, check understanding with a quick question, then continue. Never dump the whole course at once. French, concise.",
  examples: "You teach exclusively through concrete, everyday examples. Take ONE notion and build a vivid example, then ask the student to invent their own example for the next notion. French.",
  analogies: "You teach through analogies: relate each abstract notion to a familiar everyday phenomenon, then ask the student to propose their own analogy. French.",
  socratic: "You teach by Socratic questioning: never state the answer — ask a chain of guiding questions that lead the student to discover each notion themselves. French.",
  // Mémoriser
  active_recall: "You run active recall: ask short questions about the course WITHOUT showing answers. The student must retrieve from memory. After each answer, briefly confirm or correct, then ask the next question, hardest first. French.",
  leitner: "You run a Leitner-style flashcard drill: present a card (question on front), let the student answer, then reveal the back and ask them to self-grade (again/hard/good/easy) to schedule the next review. Keep cards coming until the session ends. French.",
  // Synthétiser — generators (one-shot documents)
  summary: "GENERATOR|Produce a structured course summary in French: key notions, definitions, formulas, and a 'points to remember' list. Markdown with headers.",
  fiches: "GENERATOR|Produce revision flashcards as a document in French: one 'Q:'/'R:' pair per line, 15-30 cards covering the whole course, no omissions. Markdown list.",
  mindmap: "GENERATOR|Produce a mind map of the course in French as indented markdown bullets (2-4 levels deep), capturing the structure and links between notions.",
  table: "GENERATOR|Produce a synthesis table in French (markdown table) comparing the main notions: notion | definition | example | common mistake.",
  // Réviser
  cumulative: "You run a cumulative review: mix questions from the WHOLE course and its prerequisites, oldest material first, to fight forgetting. Active-recall style, one question at a time. French.",
  // S'entraîner
  exercises: "You are a coach giving progressive exercises: start easy, increase difficulty step by step. Give ONE exercise, wait for the answer, correct it briefly, then give the next. French.",
  problems: "You give concrete problems/exercises from the course material. Give ONE problem, wait for the student's attempt, then correct with hints (never the full solution first). French.",
  transfer: "You train transfer: take a notion from the course and ask the student to apply it to a NEW, different context not covered in the course. Correct and explain the transfer. French.",
  case_study: "You run case studies: present a realistic scenario applying the course content, ask the student to analyze it, then correct and deepen. French.",
  // S'évaluer
  oral: "You simulate an oral exam: ask ONE question at a time as a strict but fair examiner, evaluate each answer briefly (what was good/missing), then ask the next. End with a short overall assessment. French.",
  // Automatisation / diagnostic
  prerequisites: "You check prerequisite knowledge: ask questions about the PRIOR knowledge needed to understand this course (from earlier chapters or general culture). Identify gaps, explain briefly what's missing, then bridge to the course. French.",
  diagnose: "You run a diagnostic: ask a rapid series of questions covering the whole course to detect weak spots. Do NOT teach — only assess, then list the weak notions at the end. French.",
  quick_check: "You run a quick comprehension check: ask 3-5 short questions verifying the key notions are understood, with immediate brief correction. End with a verdict per notion. French.",

  // ===== Spec §1 Apprendre — complementary methods =====
  dual_coding: "You teach with dual coding: pair every explanation with a precise description of a visual schema, diagram or graphic that would illustrate it (describe it in words since you cannot draw). Alternate text and 'visual' descriptions. French.",
  chunking: "You teach with chunking: break the course into small logical blocks of 3-5 ideas max. Teach ONE block, verify with a quick question, then move to the next block. Never overload. French.",

  // ===== Spec §2 Réviser =====
  targeted: "You run targeted review: focus ONLY on the weakest notions (see WEAK NOTIONS if provided, otherwise ask the student which parts feel shaky). Drill those specifically with active recall. French.",
  interleaving: "You run interleaved review: deliberately MIX different notion types and exercise kinds in each question (definition + formula + mechanism + exception), never blocking by topic. French.",
  blurting: "You run the blurting method: ask the student to write/dump EVERYTHING they remember about the course or a topic, without notes. Then compare their dump with the course and highlight what was missing or wrong. French.",

  // ===== Spec §3 Relecture rapide (interactive variants) =====
  reactivation: "You run rapid reactivation: fire very short recall prompts (one line each) covering the whole course — term → definition, date → event, formula → use. Fast pace, brief corrections. French.",

  // ===== Spec §4 Tester ses connaissances =====
  open_questions: "You assess with open questions: ask questions requiring the student to formulate their own answer (no choices). Evaluate completeness, then show what a good answer contains. French.",
  true_false: "You quiz with true/false statements about the course. Present ONE statement, wait for vrai/faux + justification, correct briefly, continue. Mix true and false. French.",
  fill_blanks: "You quiz with fill-in-the-blank: give sentences from the course with key words replaced by ___. The student must supply the missing words. Correct each immediately. French.",
  reverse_questions: "You run reverse questioning: give an answer, definition or result and ask the student to find the corresponding question/notion. Correct and continue. French.",
  restatement: "You test restatement: ask the student to retell a section of the course in their own words without notes, then compare with the source and point out omissions. French.",

  // ===== Spec §6 Approfondir =====
  direct_application: "You give direct-application exercises: each exercise applies ONE specific notion immediately after it's recalled. Start simple, correct briefly, increase difficulty. French.",
  problem_solving: "You give complex problems requiring MULTIPLE course notions combined. One problem at a time, hint before solution. French.",
  pbl: "You run problem-based learning: present an open real-world problem, let the student discover which course notions are needed, guide them to solve it. French.",
  learning_from_errors: "You train error analysis: present statements, solutions or reasoning that CONTAIN errors. The student must spot and correct them, then explain the right way. French.",
  synthesis_exercises: "You give synthesis exercises mobilizing several course sections at once (compare, combine, apply across topics). One at a time with correction. French.",

  // ===== Spec §9 Revoir le cours du jour =====
  immediate_recall: "You run immediate recall: just after the course was covered, ask rapid questions on today's material to consolidate first acquisitions. Short, encouraging, one question at a time. French.",
  mini_test: "You run a mini comprehension test on today's course: 3-5 quick questions, immediate brief feedback, then a verdict on which notions need more work. French.",
  today_fiche: "You produce a synthetic fiche of TODAY's course session only (the most recent content): essentials, definitions, formulas. Markdown. French.",

  // ===== Spec §10 Fonctionnalités intelligentes =====
  error_analysis: "You analyze the student's recurring errors from the session: identify error patterns, explain the underlying misconception for each, and propose targeted remediation. French.",
  gap_prediction: "You predict upcoming gaps: based on the course structure and the student's mastery, identify which FUTURE chapters or advanced notions will be hardest and why. French.",
};

const LEARN_GENERATORS = new Set([
  // Synthétiser / Structurer (§3, §5)
  "summary", "fiches", "mindmap", "table",
  "skim", "scan", "keywords", "outline_read", "synth_read",
  "course_outline", "concept_map", "timeline", "logic_tree", "glossary", "priorities",
  // Fiches de révision (§7)
  "fiche_definitions", "fiche_formulas", "fiche_method", "fiche_errors", "fiche_chrono", "fiche_theme",
  // Plan intelligent (§10)
  "smart_plan", "today_fiche",
]);

const LEARN_GEN_PROMPTS = {
  // §3 Relecture rapide
  skim: "Produce a quick-reading guide for this course in French: the general structure, big ideas per section, and what to look at first. Markdown, concise.",
  scan: "Produce a scanning sheet in French: every precise fact to locate quickly — dates, definitions, formulas, names, numbers — as a markdown list grouped by theme.",
  keywords: "Extract and highlight the essential keywords of the course in French: key terms with a one-line definition each, as a markdown list.",
  outline_read: "Produce the course skeleton in French: titles and subtitles structure with one-line summaries — for rapid browsing. Markdown.",
  synth_read: "Produce a very short synthetic version of the course in French keeping ONLY essential information. Max ~300 words, markdown.",
  // §5 Structurer
  course_outline: "Produce a hierarchical plan of the course in French: chapters > parts > sub-parts > notions, as indented markdown bullets with one-line descriptions.",
  concept_map: "Produce a concept map in French as indented markdown: central notion with related concepts, their relations (is-a, causes, requires, opposes) in parentheses.",
  timeline: "Produce a chronological timeline in French: every dated event/step of the course in order, markdown numbered list.",
  logic_tree: "Produce a logic tree in French: cause → consequence → dependency relations between notions, as indented markdown bullets.",
  glossary: "Produce a glossary in French: EVERY important term of the course with a precise one-sentence definition, alphabetical markdown list.",
  priorities: "Produce a knowledge prioritization in French: rank every notion as fondamental / secondaire / complémentaire with justification, markdown list.",
  // §7 Fiches de révision
  fiche_definitions: "Produce a definitions fiche in French: group ALL important definitions of the course, term → definition, markdown list.",
  fiche_formulas: "Produce a formulas fiche in French: every formula/property with its conditions of use and parameters, markdown list.",
  fiche_method: "Produce a method fiche in French: the step-by-step procedures to solve exercises from this course, numbered markdown.",
  fiche_errors: "Produce an errors fiche in French: frequent mistakes on this course and their corrections, markdown list.",
  fiche_chrono: "Produce a chronological fiche in French: all important dates and events of the course, markdown list.",
  fiche_theme: "Produce thematic fiches in French: one fiche per main notion of the course (notion → key points → example → common mistake), as markdown sections.",
  // §10 Plan intelligent
  smart_plan: "Produce a personalized revision plan in French based on this course: which notions to review, in which order, with which method, and suggested spacing (J0/J1/J3/J7). Markdown.",
  today_fiche: "Produce a synthetic fiche of the MOST RECENT course session only: essentials, definitions, formulas. Markdown, concise.",
};

async function learn(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const method = String(body?.method || "");
  const spec = LEARN_METHODS[method];
  if (!spec) throw new Error(`Unknown learn method: ${method}`);

  const subject = await getSubject(env, ch.subject_id);
  const source = truncate(chapterSource(ch), 26000);
  const header = [
    `Chapter: ${ch.lesson_name || "untitled"}`,
    subject?.subject_name && `Subject: ${subject.subject_name}`,
    ch.lesson_description && `Description: ${ch.lesson_description}`,
    ch.teacher_notes && `Teacher expectations: ${ch.teacher_notes}`,
    subject?.teacher_notes && `Subject teacher expectations: ${subject.teacher_notes}`,
  ].filter(Boolean).join("\n");

  const courseBlock = `=== COURSE MATERIAL ===\n${source || "(no course content yet — work from the chapter description)"}`;

  // Mastery: surface weak notions so the tutor prioritizes them.
  let masteryBlock = "";
  try {
    const m = typeof ch.mastery === "string" ? JSON.parse(ch.mastery) : ch.mastery;
    const weak = Object.entries(m?.notion_scores || {})
      .filter(([, v]) => (v?.score ?? 100) < 60)
      .sort((a, b) => (a[1].score ?? 0) - (b[1].score ?? 0))
      .slice(0, 8)
      .map(([n, v]) => `- ${n} (${v.score}%)`);
    if (weak.length) masteryBlock = `\n=== WEAK NOTIONS (prioritize these) ===\n${weak.join("\n")}`;
  } catch {}

  if (LEARN_GENERATORS.has(method)) {
    const base = LEARN_GEN_PROMPTS[method] || spec.replace(/^GENERATOR\|/, "");
    const prompt = `${base}
${header}

${courseBlock}

Respond in French, markdown allowed.`;
    const material = (await ai(env, prompt, 3500)).trim();
    return { method, material: material || "Le modèle n'a rien produit — réessayez." };
  }

  // Interactive session — history is [{role:"user"|"ai", content}]
  const history = Array.isArray(body?.history) ? body.history.slice(-16) : [];
  const message = String(body?.message || "").trim();
  const transcript = history.map((h) => `${h.role === "user" ? "Student" : "Tutor"}: ${String(h.content || "").slice(0, 2000)}`).join("\n");

  const prompt = `${spec}
${header}

${courseBlock}${masteryBlock}

${transcript ? `=== SESSION SO FAR ===\n${transcript}\n` : ""}${message ? `Student: ${message}\n` : "Student: (start the session — give your first step/question)"}
Tutor:`;

  const reply = (await fastAI(env, prompt, 1400)).trim();
  return { method, reply: reply || "…", done: false };
}

// End-of-session debrief: the fast model grades the transcript, scores each
// notion 0-100 and recommends the next method. Results are merged into
// chapters.mastery so the tutor adapts over time.
async function learnDebrief(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const method = String(body?.method || "");
  const transcript = String(body?.transcript || "").slice(-12000);
  if (!transcript.trim()) throw new Error("Empty session transcript");

  const methodKeys = Object.keys(LEARN_METHODS).join(", ");
  const prompt = `You are an expert learning analyst. Below is a tutoring session transcript for a school chapter.

Chapter: ${ch.lesson_name || "untitled"}
Method used: ${method}

=== TRANSCRIPT ===
${transcript}

Respond ONLY with JSON (no markdown fences):
{
  "summary": "2-3 sentences in French summarizing what was covered and how the student did",
  "notions": [{"notion": "name of the notion", "score": 0-100}],
  "recommendation": {"method": "one of: ${methodKeys}", "focus": "what to work on next, in French"}
}
Scores: 0-30 = not understood, 31-60 = fragile, 61-85 = correct, 86-100 = mastered. Only include notions actually assessed in the transcript.`;

  const raw = await fastAI(env, prompt, 1600);
  const parsed = extractJSON(raw) || {};
  const notions = Array.isArray(parsed.notions) ? parsed.notions : [];

  // Merge into chapter.mastery
  let mastery = {};
  try { mastery = typeof ch.mastery === "string" ? JSON.parse(ch.mastery) : (ch.mastery || {}); } catch { mastery = {}; }
  mastery.notion_scores = mastery.notion_scores && typeof mastery.notion_scores === "object" ? mastery.notion_scores : {};
  const today = new Date().toISOString().slice(0, 10);
  for (const n of notions) {
    const name = String(n?.notion || "").trim().slice(0, 120);
    const score = Math.max(0, Math.min(100, Number(n?.score) || 0));
    if (!name) continue;
    const prev = mastery.notion_scores[name] || { score: 100, reviews: 0 };
    // Running average weighted by review count (cap weight to stay reactive)
    const w = Math.min(prev.reviews || 0, 5);
    mastery.notion_scores[name] = {
      score: Math.round(((prev.score * w) + score) / (w + 1)),
      reviews: (prev.reviews || 0) + 1,
      last: today,
    };
  }
  mastery.sessions = Array.isArray(mastery.sessions) ? mastery.sessions : [];
  mastery.sessions.push({ date: today, method, summary: String(parsed.summary || "").slice(0, 400) });
  mastery.sessions = mastery.sessions.slice(-30);
  const all = Object.values(mastery.notion_scores);
  mastery.avg = all.length ? Math.round(all.reduce((s, v) => s + v.score, 0) / all.length) : null;
  mastery.updated = new Date().toISOString();

  // Persist the current lacunes (weak notions) on the chapter for quick access.
  const gaps = Object.entries(mastery.notion_scores)
    .filter(([, v]) => (v?.score ?? 100) < 60)
    .sort((a, b) => (a[1].score ?? 0) - (b[1].score ?? 0))
    .map(([n]) => n)
    .slice(0, 20);

  await updateChapter(env, ch.lesson_id, { mastery: JSON.stringify(mastery), gaps: JSON.stringify(gaps) });

  return {
    summary: parsed.summary || "",
    notions: Object.entries(mastery.notion_scores)
      .map(([notion, v]) => ({ notion, ...v }))
      .sort((a, b) => a.score - b.score),
    avg: mastery.avg,
    recommendation: parsed.recommendation || null,
  };
}

// Lesson-text cleanup: fixes OCR / voice / typing recognition errors, arranges
// the text into proper sentences and lets the student give extra instructions.
// The model must preserve the exact knowledge — poems keep their form, irregular
// verbs keep their correct spelling, nothing is invented or summarized.
async function cleanLesson(env, body) {
  const text = String(body?.text || "").trim();
  if (!text) throw new Error("No text to clean");
  const instructions = String(body?.instructions || "").trim().slice(0, 2000);
  const source = String(body?.source || "import").slice(0, 40);

  const clip = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n)}\n[…truncated…]` : t;
  };

  const prompt = `You are a meticulous lesson-text editor. Below is raw text extracted from a student's lesson source (${source}) — it may contain recognition errors from OCR, voice transcription or typing.

YOUR JOB:
1. Fix recognition/transcription errors using your real knowledge of the subject: correct spellings (e.g. irregular verbs, poetry lines, technical terms, formulas, dates, names), fix broken sentences, restore proper punctuation and paragraph structure.
2. Arrange the content into clean, readable sentences and paragraphs.
3. Preserve the EXACT knowledge: do NOT invent facts, do NOT summarize, do NOT remove content, do NOT translate (unless instructed below).
4. SPECIAL CASES — never "correct" these into prose:
   - Poems / verse: keep line breaks and the exact wording.
   - Lists, tables, formulas, code: keep their structure.
   - Proper nouns, technical vocabulary, irregular forms: keep them exact.
5. If additional instructions are provided, apply them on top of the cleanup.

${instructions ? `ADDITIONAL INSTRUCTIONS FROM THE STUDENT:
« ${instructions} »
` : ""}
OUTPUT: return ONLY the cleaned lesson text — no commentary, no markdown fences, no explanations.

=== RAW TEXT ===
${clip(text, 30000)}`;

  const cleaned = (await ai(env, prompt, 16000)) || "";
  const out = cleaned.trim();
  if (!out) throw new Error("AI returned an empty result");
  return { text: out, instructions_applied: !!instructions };
}

// AI-assisted course edit: the student describes a problem/change in plain
// language; the model rewrites ONLY what is necessary and decides whether the
// flashcards are impacted. Returns full field contents (never diffs) so the
// stored course stays complete and consistent.
async function editCourse(env, body) {
  const ch = await getChapter(env, body?.lesson_id);
  if (!ch) throw new Error("Chapter not found");
  const instruction = String(body?.instruction || "").trim();
  if (!instruction) throw new Error("Describe the change first");

  const targets = new Set(Array.isArray(body?.targets) ? body.targets.map(String) : ["body"]);
  const allowBody = targets.has("body");
  const allowRaw = targets.has("raw_lessons");
  const allowFlash = targets.has("flashcards");
  if (!allowBody && !allowRaw && !allowFlash) throw new Error("Pick at least one target");

  const clip = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n)}\n[…content truncated…]` : t;
  };

  // Compact flashcard snapshot so the model can judge whether they still fit.
  let flashInfo = "No flashcards yet.";
  try {
    const fc = typeof ch.flashcards === "string" ? JSON.parse(ch.flashcards) : ch.flashcards;
    if (Array.isArray(fc?.cards) && fc.cards.length) {
      flashInfo = `${fc.cards.length} cards. Sample:\n` + fc.cards.slice(0, 15)
        .map((c) => `Q: ${String(c?.front || "").slice(0, 90)} → A: ${String(c?.back || "").slice(0, 90)}`)
        .join("\n");
    }
  } catch {}

  const editable = [
    allowBody ? "COURSE BODY (the generated course shown to the student)" : "",
    allowRaw ? "RAW LESSON TEXT (the source notes the course was built from)" : "",
    allowFlash ? "FLASHCARDS (decide only — the system regenerates them if needed)" : "",
  ].filter(Boolean).join("\n- ");

  const prompt = `You are a meticulous course editor. The student reports this issue / requests this change:

« ${instruction} »

You may ONLY modify these parts of the chapter:
- ${editable}

STRICT RULES:
- Modify ONLY what the request requires. EVERYTHING else must remain strictly identical — same wording, same order, same formatting, same markdown.
- For each editable text field: return the COMPLETE new version in full, or null if it does not need changes. NEVER return a diff, excerpt or "…".
- For FLASHCARDS: set "update" to true ONLY if the change makes existing flashcards wrong/misleading or leaves important new facts uncovered; otherwise false. Always give a one-line reason.
- If teacher_notes are provided below, respect the teacher's expectations (format, emphasis, level).
- If the request is ambiguous, make the smallest reasonable change that fixes the reported problem.
- Answer in the same language as the course content (French unless the course is in another language).

Respond with STRICT JSON only, no markdown:
{"changes":{"body":"<full new body or null>","raw_lessons":"<full new raw text or null>","flashcards":{"update":true|false,"reason":"<one line or null>"}},"summary":"<1-2 sentences in French explaining what you changed>"}

=== CURRENT COURSE BODY ===
${clip(ch.body, 80000)}

=== RAW LESSON TEXT ===
${clip([ch.raw_lessons, ch.raw_recorded_lessons].filter(Boolean).join("\n\n---\n\n"), 40000)}

=== FLASHCARDS (current) ===
${clip(flashInfo, 8000)}

=== TEACHER NOTES ===
${clip(ch.teacher_notes, 4000) || "(none)"}`;

  const raw = await ai(env, prompt, 32000);
  const parsed = extractJSON(raw);
  const changes = parsed?.changes && typeof parsed.changes === "object" ? parsed.changes : {};

  const applied = [];
  const fields = {};
  if (allowBody && typeof changes.body === "string" && changes.body.trim()) { fields.body = changes.body; applied.push("body"); }
  if (allowRaw && typeof changes.raw_lessons === "string" && changes.raw_lessons.trim()) { fields.raw_lessons = changes.raw_lessons; applied.push("raw_lessons"); }
  if (Object.keys(fields).length) await updateChapter(env, body.lesson_id, fields);

  // Flashcards: the model decided; regenerate from the UPDATED source when needed.
  let flashcardsResult = "not_requested";
  if (allowFlash) {
    const wantsUpdate = changes.flashcards?.update === true || changes.flashcards?.update === "true";
    if (wantsUpdate) {
      try {
        const r = await flashcards(env, { lesson_id: body.lesson_id });
        flashcardsResult = `regenerated (${r.count} cards)`;
      } catch (e) {
        flashcardsResult = `regeneration failed: ${e.message}`;
      }
    } else {
      flashcardsResult = `checked — still accurate (${changes.flashcards?.reason || "no impact"})`;
    }
  }

  return {
    applied,
    flashcards: flashcardsResult,
    summary: String(parsed?.summary || "").trim() || null,
  };
}

export async function LearningFunction(env, subpath, method, body) {
  if (!env.AI) throw new Error("Workers AI binding (AI) is not configured");
  if (env.subjects_data) await ensureChapterColumns(env.subjects_data).catch(() => {});
  const action = String(subpath || "").replace(/^\/+|\/+$/g, "") || "";

  switch (action) {
    case "course-plan": return await coursePlan(env, body);
    case "course-section": return await courseSection(env, body);
    case "course-status": return await courseStatus(env, body);
    case "flashcards": return await flashcards(env, body);
    case "review-status": return await reviewStatus(env, body);
    case "review-log": return await reviewLog(env, body);
    case "activities": return await activities(env, body);
    case "feedback": return await feedback(env, body);
    case "ask": return await ask(env, body);
    case "test-report": return await testReport(env, body);
    case "ai-comment": return await aiComment(env, body);
    case "learn": return await learn(env, body);
    case "learn-debrief": return await learnDebrief(env, body);
    case "edit-course": return await editCourse(env, body);
    case "clean-lesson": return await cleanLesson(env, body);
    default: throw new Error(`Unknown learning action: ${action}`);
  }
}
