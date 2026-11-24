// Learning AI — course generation, flashcards, activities & feedback.
// Backed by `subjects_data` (chapters + generation_jobs) and Workers AI.

import { callModel } from "../ai/core.js";

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

  // Append to chapters.body
  const header = `\n\n## ${sections[i].title}\n\n`;
  const newBody = (ch.body || "") + header + content.trim() + "\n";
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

  const prompt = `You are an expert flashcard designer. From the course material below, create EVERY flashcard needed to memorize it — miss nothing: definitions, formulas, dates, names, mechanisms, comparisons, exceptions.

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

  await updateChapter(env, body.lesson_id, { flashcards: JSON.stringify({ cards, generated_at: new Date().toISOString() }) });
  return { count: cards.length };
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

export async function LearningFunction(env, subpath, method, body) {
  if (!env.AI) throw new Error("Workers AI binding (AI) is not configured");
  const action = String(subpath || "").replace(/^\/+|\/+$/g, "") || "";

  switch (action) {
    case "course-plan": return await coursePlan(env, body);
    case "course-section": return await courseSection(env, body);
    case "course-status": return await courseStatus(env, body);
    case "flashcards": return await flashcards(env, body);
    case "activities": return await activities(env, body);
    case "feedback": return await feedback(env, body);
    case "ask": return await ask(env, body);
    case "test-report": return await testReport(env, body);
    default: throw new Error(`Unknown learning action: ${action}`);
  }
}
