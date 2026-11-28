// Subjects & chapters API — backed by the `subjects_data` D1 database.
// subjects: subject_id, subject_name, ed_subject_id/code/name, comments,
//           tests_comments, ai_comments, methods
// chapters (lessons): lesson_id, lesson_name, lesson_description,
//           parents/childs_lessons_id, subject_id, body, raw_lessons,
//           raw_recorded_lessons, flashcards, tests, tests_results,
//           linked_files/quizlets/websites, is_method, is_yearly,
//           methods, tests_date, comments, ai_comments

const SUBJECT_DEFAULTS = { methods: "[]" };
const CHAPTER_DEFAULTS = { is_method: 0, is_yearly: 0 };

// Subject-level extras (teacher expectations for the whole subject).
const SUBJECT_EXTRA_COLUMNS = [
  ["teacher_notes", "TEXT"],
  ["attachements_id", "TEXT"],
];
let subjectColumnsReady = false;

async function ensureSubjectColumns(db) {
  if (subjectColumnsReady) return;
  try {
    const { results } = await db.prepare("PRAGMA table_info(subjects)").all();
    const existing = new Set((results || []).map((r) => r.name));
    for (const [name, decl] of SUBJECT_EXTRA_COLUMNS) {
      if (!existing.has(name)) {
        await db.prepare(`ALTER TABLE subjects ADD COLUMN ${name} ${decl}`).run();
      }
    }
    columnCache.delete("subjects");
  } catch { /* subjects table may not exist yet */ }
  subjectColumnsReady = true;
}

// Extra chapter columns added lazily — ALTER TABLE is cheap and idempotent.
const CHAPTER_EXTRA_COLUMNS = [
  ["session_date", "TEXT"],
  ["awaiting_evaluation", "INTEGER DEFAULT 0"],
  ["review_plan", "TEXT"],
  ["teacher_notes", "TEXT"],
  ["attachements_id", "TEXT"],
  ["mastery", "TEXT"],
  ["gaps", "TEXT"],
];
let chapterColumnsReady = false;

const columnCache = new Map();

export async function ensureChapterColumns(db) {
  if (chapterColumnsReady) return;
  const { results } = await db.prepare("PRAGMA table_info(chapters)").all();
  const existing = new Set((results || []).map((r) => r.name));
  for (const [name, decl] of CHAPTER_EXTRA_COLUMNS) {
    if (!existing.has(name)) {
      await db.prepare(`ALTER TABLE chapters ADD COLUMN ${name} ${decl}`).run();
    }
  }
  columnCache.delete("chapters");
  chapterColumnsReady = true;
}

async function tableColumns(db, table) {
  const key = `${db === undefined ? "" : ""}${table}`;
  if (!columnCache.has(key)) {
    try {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
      columnCache.set(key, new Set((results || []).map((r) => r.name)));
    } catch {
      columnCache.set(key, new Set());
    }
  }
  return columnCache.get(key);
}

function pickFields(row, columns) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (columns.has(k) && v !== undefined) {
      out[k] = (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
    }
  }
  return out;
}

async function nextId(db, table, idCol) {
  const row = await db.prepare(`SELECT COALESCE(MAX(${idCol}), 0) + 1 AS id FROM ${table}`).first();
  return Number(row?.id) || 1;
}

async function insertRow(db, table, idCol, fields, defaults = {}) {
  const cols = await tableColumns(db, table);
  const clean = pickFields({ ...defaults, ...fields }, cols);
  clean[idCol] = fields[idCol];
  const keys = Object.keys(clean).filter((k) => cols.has(k));
  if (!keys.length) throw new Error("No writable fields provided");
  await db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...keys.map((k) => clean[k])).run();
  return clean[idCol];
}

export async function SubjectsFunction(env, subpath, method, body) {
  const db = env.subjects_data;
  if (!db) throw new Error("subjects_data D1 binding is not configured");
  const action = String(subpath || "").replace(/^\/+|\/+$/g, "") || "list";
  await ensureSubjectColumns(db);
  if (action.includes("chapter")) await ensureChapterColumns(db);

  switch (action) {
    case "list": {
      const subjects = (await db.prepare("SELECT * FROM subjects ORDER BY subject_id").all()).results || [];
      let chapters = [];
      if (body?.subject_id !== undefined && body?.subject_id !== null && body?.subject_id !== "") {
        chapters = (await db.prepare("SELECT * FROM chapters WHERE subject_id = ? ORDER BY lesson_id")
          .bind(Number(body.subject_id)).all()).results || [];
      } else if (body?.all_chapters) {
        chapters = (await db.prepare("SELECT * FROM chapters ORDER BY subject_id, lesson_id").all()).results || [];
      }
      return { subjects, chapters };
    }

    case "create-subject": {
      const id = await nextId(db, "subjects", "subject_id");
      const fields = { ...(body?.fields || body || {}) };
      delete fields.subject_id;
      await insertRow(db, "subjects", "subject_id", { ...fields, subject_id: id }, SUBJECT_DEFAULTS);
      const row = await db.prepare("SELECT * FROM subjects WHERE subject_id = ?").bind(id).first();
      return { created: true, subject: row };
    }

    case "update-subject": {
      const cols = await tableColumns(db, "subjects");
      const clean = pickFields(body?.fields || {}, cols);
      delete clean.subject_id;
      const keys = Object.keys(clean);
      if (!keys.length) throw new Error("No writable fields provided");
      await db.prepare(`UPDATE subjects SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE subject_id = ?`)
        .bind(...keys.map((k) => clean[k]), Number(body?.subject_id)).run();
      const row = await db.prepare("SELECT * FROM subjects WHERE subject_id = ?").bind(Number(body.subject_id)).first();
      return { updated: true, subject: row };
    }

    case "delete-subject": {
      // Chapters keep their subject_id reference; delete them too for coherence.
      await db.prepare("DELETE FROM chapters WHERE subject_id = ?").bind(Number(body?.subject_id)).run();
      await db.prepare("DELETE FROM subjects WHERE subject_id = ?").bind(Number(body?.subject_id)).run();
      return { deleted: true, subject_id: Number(body?.subject_id) };
    }

    case "create-chapter": {
      const id = await nextId(db, "chapters", "lesson_id");
      const fields = { ...(body?.fields || body || {}) };
      delete fields.lesson_id;
      if (fields.subject_id === undefined || fields.subject_id === null || fields.subject_id === "") {
        throw new Error("subject_id is required for a chapter");
      }
      fields.subject_id = Number(fields.subject_id);
      await insertRow(db, "chapters", "lesson_id", { ...fields, lesson_id: id }, CHAPTER_DEFAULTS);
      const row = await db.prepare("SELECT * FROM chapters WHERE lesson_id = ?").bind(id).first();
      return { created: true, chapter: row };
    }

    case "update-chapter": {
      const cols = await tableColumns(db, "chapters");
      const clean = pickFields(body?.fields || {}, cols);
      delete clean.lesson_id;
      if (clean.subject_id !== undefined) clean.subject_id = Number(clean.subject_id);
      const keys = Object.keys(clean);
      if (!keys.length) throw new Error("No writable fields provided");
      await db.prepare(`UPDATE chapters SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE lesson_id = ?`)
        .bind(...keys.map((k) => clean[k]), Number(body?.lesson_id)).run();
      const row = await db.prepare("SELECT * FROM chapters WHERE lesson_id = ?").bind(Number(body?.lesson_id)).first();
      return { updated: true, chapter: row };
    }

    case "delete-chapter": {
      await db.prepare("DELETE FROM chapters WHERE lesson_id = ?").bind(Number(body?.lesson_id)).run();
      return { deleted: true, lesson_id: Number(body?.lesson_id) };
    }

    default:
      throw new Error(`Unknown subjects action: ${action}`);
  }
}
