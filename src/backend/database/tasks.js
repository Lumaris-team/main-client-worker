// Tasks API — backed by the `timetable` D1 database.
// Tables: tasks, trash_tasks, repeat_tasks (+ events variants).
// Columns are detected via PRAGMA so schema drift doesn't break writes.

const TABLES = {
  tasks: "tasks",
  trash: "trash_tasks",
  repeat: "repeat_tasks",
  events: "events",
  trash_events: "trash_events",
  repeat_events: "repeat_events",
};

// Where a deleted row goes, and where a restored row comes back to.
const TRASH_TARGET = {
  tasks: "trash_tasks",
  repeat_tasks: "trash_tasks",
  events: "trash_events",
  repeat_events: "trash_events",
};
const RESTORE_TARGET = {
  trash_tasks: "tasks",
  trash_events: "events",
};

// Lookup tables managed from /settings → Workspace.
const LOOKUPS = {
  labels: { table: "labels", idCol: "label_id" },
  flags: { table: "flags", idCol: "flag_id" },
  types: { table: "task_types", idCol: "type_id" },
  methods: { table: "methods", idCol: "method_id" },
  priorities: { table: "priorities", idCol: "priority_id" },
  attention: { table: "attention_levels", idCol: "attention_level_id" },
  folders: { table: "folders", idCol: "folder_id" },
};

// Defaults for NOT NULL columns when the client omits them.
const CREATE_DEFAULTS = {
  path: "/",
  is_done: 0,
  remind: 0,
  is_homework: 0,
  push_tasks: 0,
  frequency: "custom",
};

const columnCache = new Map();

// Extra columns added lazily — ALTER TABLE is cheap and idempotent.
const TASK_EXTRA_COLUMNS = [
  ["linked_action", "TEXT"],
];
let taskColumnsReady = false;

async function ensureTaskColumns(db) {
  if (taskColumnsReady) return;
  for (const table of Object.values(TABLES)) {
    try {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
      const existing = new Set((results || []).map((r) => r.name));
      for (const [name, decl] of TASK_EXTRA_COLUMNS) {
        if (!existing.has(name)) {
          await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`).run();
        }
      }
      columnCache.delete(table);
    } catch { /* table may not exist yet */ }
  }
  taskColumnsReady = true;
}

async function tableColumns(db, table) {
  if (!columnCache.has(table)) {
    try {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
      columnCache.set(table, new Set((results || []).map((r) => r.name)));
    } catch {
      columnCache.set(table, new Set());
    }
  }
  return columnCache.get(table);
}

function resolveTable(name) {
  const key = String(name || "tasks");
  const table = TABLES[key] || (Object.values(TABLES).includes(key) ? key : null);
  if (!table) throw new Error(`Unknown tasks table: ${name}`);
  return table;
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

async function nextId(db, table, idCol = "task_id") {
  const row = await db.prepare(`SELECT COALESCE(MAX(${idCol}), 0) + 1 AS id FROM ${table}`).first();
  return Number(row?.id) || 1;
}

async function insertRow(db, table, fields) {
  const cols = await tableColumns(db, table);
  const clean = pickFields(fields, cols);
  const keys = Object.keys(clean);
  if (!keys.length) throw new Error("No writable fields provided");
  const placeholders = keys.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
  await db.prepare(sql).bind(...keys.map((k) => clean[k])).run();
  return clean.task_id ?? fields.task_id;
}

async function getRow(db, table, taskId) {
  const cols = await tableColumns(db, table);
  if (!cols.has("task_id")) throw new Error(`${table} has no task_id column`);
  return db.prepare(`SELECT * FROM ${table} WHERE task_id = ?`).bind(Number(taskId)).first();
}

async function moveRow(db, fromTable, toTable, taskId, extraFields = {}) {
  const row = await getRow(db, fromTable, taskId);
  if (!row) throw new Error(`Task ${taskId} not found in ${fromTable}`);
  const cols = await tableColumns(db, toTable);
  const fields = pickFields({ ...row, ...extraFields }, cols);
  const keys = Object.keys(fields);
  const placeholders = keys.map(() => "?").join(", ");
  await db.prepare(`INSERT INTO ${toTable} (${keys.join(", ")}) VALUES (${placeholders})`)
    .bind(...keys.map((k) => fields[k])).run();
  await db.prepare(`DELETE FROM ${fromTable} WHERE task_id = ?`).bind(Number(taskId)).run();
  return fields;
}

export async function TasksFunction(env, subpath, method, body, session) {
  const db = env.timetable;
  if (!db) throw new Error("timetable D1 binding is not configured");
  const action = String(subpath || "").replace(/^\/+|\/+$/g, "") || "list";
  await ensureTaskColumns(db);

  switch (action) {
    case "list": {
      const wanted = Array.isArray(body?.tables) && body.tables.length
        ? body.tables.map(resolveTable)
        : ["tasks", "trash_tasks", "repeat_tasks"];
      const result = {};
      for (const table of wanted) {
        let sql = `SELECT * FROM ${table}`;
        const clauses = [];
        const binds = [];
        if (body?.done !== undefined && body?.done !== null && table !== "trash_tasks") {
          clauses.push("is_done = ?");
          binds.push(body.done ? 1 : 0);
        }
        if (body?.q) {
          clauses.push("(title LIKE ? OR text_body LIKE ?)");
          binds.push(`%${body.q}%`, `%${body.q}%`);
        }
        if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
        sql += " ORDER BY is_done ASC, task_id DESC";
        const { results } = await db.prepare(sql).bind(...binds).all();
        result[table] = results || [];
      }
      return { tables: result };
    }

    case "create": {
      const table = resolveTable(body?.table || "tasks");
      if (!["tasks", "repeat_tasks", "events", "repeat_events"].includes(table)) {
        throw new Error("Cannot create directly into a trash table");
      }
      const id = await nextId(db, table);
      const fields = { ...(body?.fields || body || {}) };
      delete fields.table;
      fields.task_id = id;
      const cols = await tableColumns(db, table);
      for (const [k, v] of Object.entries(CREATE_DEFAULTS)) {
        if (cols.has(k) && fields[k] === undefined) fields[k] = v;
      }
      await insertRow(db, table, fields);
      const row = await getRow(db, table, id);
      return { created: true, table, task: row };
    }

    case "update": {
      const table = resolveTable(body?.table || "tasks");
      const cols = await tableColumns(db, table);
      const clean = pickFields(body?.fields || {}, cols);
      delete clean.task_id;
      const keys = Object.keys(clean);
      if (!keys.length) throw new Error("No writable fields provided");
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE task_id = ?`;
      await db.prepare(sql).bind(...keys.map((k) => clean[k]), Number(body?.task_id)).run();
      const row = await getRow(db, table, body?.task_id);
      return { updated: true, table, task: row };
    }

    case "toggle": {
      const table = resolveTable(body?.table || "tasks");
      const row = await getRow(db, table, body?.task_id);
      if (!row) throw new Error("Task not found");
      const next = row.is_done ? 0 : 1;
      await db.prepare(`UPDATE ${table} SET is_done = ? WHERE task_id = ?`)
        .bind(next, Number(body.task_id)).run();
      return { task_id: Number(body.task_id), table, is_done: next };
    }

    case "delete": {
      const table = resolveTable(body?.table || "tasks");
      const trash = TRASH_TARGET[table];
      if (!trash) throw new Error(`Cannot trash ${table}`);
      const moved = await moveRow(db, table, trash, body?.task_id);
      return { deleted: true, from: table, to: trash, task: moved };
    }

    case "restore": {
      const table = resolveTable(body?.table || "trash_tasks");
      if (!RESTORE_TARGET[table]) throw new Error(`Cannot restore from ${table}`);
      // A row carrying a frequency comes back as a repeat task.
      const source = await getRow(db, table, body?.task_id);
      const hasFreq = source && (source.frequency || (typeof source.excludes_periods === "string" && source.excludes_periods));
      const target = hasFreq && table === "trash_tasks" ? "repeat_tasks" : RESTORE_TARGET[table];
      const moved = await moveRow(db, table, target, body?.task_id);
      return { restored: true, from: table, to: target, task: moved };
    }

    case "purge": {
      const table = resolveTable(body?.table || "trash_tasks");
      if (!table.startsWith("trash_")) throw new Error("Purge is only allowed on trash tables");
      await db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).bind(Number(body?.task_id)).run();
      return { purged: true, table, task_id: Number(body?.task_id) };
    }

    case "meta": {
      const meta = {};
      for (const [key, def] of Object.entries(LOOKUPS)) {
        try {
          const { results } = await db.prepare(`SELECT * FROM ${def.table} ORDER BY ${def.idCol}`).all();
          meta[key] = results || [];
        } catch {
          meta[key] = [];
        }
      }
      // Seed default learning methods once so tasks can be linked to them.
      if (!meta.methods?.length) {
        const defaults = [
          ["Apprentissage", "Course learning / lesson intake"],
          ["Révision", "Review sessions and spaced repetition"],
          ["Ajout de leçon", "Importing lesson content (PDF, voice, OCR…)"],
          ["Flashcards", "Flashcard generation and review"],
          ["Tests & activités", "Exercise and test generation"],
          ["Questions IA", "Asking the AI about the course"],
          ["Évaluation", "Awaiting / taking an evaluation"],
        ];
        try {
          for (const [name, description] of defaults) {
            const id = await nextId(db, "methods", "method_id");
            await db.prepare("INSERT INTO methods (method_id, name, description) VALUES (?, ?, ?)")
              .bind(id, name, description).run();
          }
          const { results } = await db.prepare("SELECT * FROM methods ORDER BY method_id").all();
          meta.methods = results || [];
        } catch { /* methods table may not exist — leave empty */ }
      }
      return { meta };
    }

    case "lookup": {
      const entity = String(body?.entity || "");
      const def = LOOKUPS[entity];
      if (!def) throw new Error(`Unknown lookup entity: ${entity}`);
      const op = String(body?.op || "");
      const cols = await tableColumns(db, def.table);

      if (op === "create") {
        const id = await nextId(db, def.table, def.idCol);
        const fields = pickFields({ ...(body?.fields || {}), [def.idCol]: id }, cols);
        const keys = Object.keys(fields);
        if (!keys.length) throw new Error("No writable fields provided");
        await db.prepare(`INSERT INTO ${def.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
          .bind(...keys.map((k) => fields[k])).run();
        return { created: true, entity, id };
      }

      if (op === "update") {
        const clean = pickFields(body?.fields || {}, cols);
        delete clean[def.idCol];
        const keys = Object.keys(clean);
        if (!keys.length) throw new Error("No writable fields provided");
        await db.prepare(`UPDATE ${def.table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${def.idCol} = ?`)
          .bind(...keys.map((k) => clean[k]), Number(body?.id)).run();
        return { updated: true, entity, id: Number(body?.id) };
      }

      if (op === "delete") {
        await db.prepare(`DELETE FROM ${def.table} WHERE ${def.idCol} = ?`).bind(Number(body?.id)).run();
        return { deleted: true, entity, id: Number(body?.id) };
      }

      throw new Error(`Unknown lookup op: ${op}`);
    }

    case "templates": {
      await ensureTemplatesTable(db);
      const kind = String(body?.kind || "");
      const sql = kind
        ? "SELECT * FROM templates WHERE kind = ? ORDER BY template_id DESC"
        : "SELECT * FROM templates ORDER BY template_id DESC";
      const stmt = kind ? db.prepare(sql).bind(kind) : db.prepare(sql);
      const { results } = await stmt.all();
      return { templates: (results || []).map((r) => ({ ...r, payload: safeParse(r.payload) })) };
    }

    case "template-save": {
      await ensureTemplatesTable(db);
      const kind = String(body?.kind || "");
      const name = String(body?.name || "").trim();
      const payload = body?.payload;
      if (!kind || !name || payload === undefined) throw new Error("kind, name and payload are required");
      let id = Number(body?.template_id) || 0;
      if (id) {
        await db.prepare("UPDATE templates SET kind = ?, name = ?, payload = ? WHERE template_id = ?")
          .bind(kind, name, JSON.stringify(payload), id).run();
      } else {
        id = await nextId(db, "templates", "template_id");
        await db.prepare("INSERT INTO templates (template_id, kind, name, payload, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
          .bind(id, kind, name, JSON.stringify(payload)).run();
      }
      return { saved: true, template_id: id };
    }

    case "template-delete": {
      await ensureTemplatesTable(db);
      const id = Number(body?.template_id);
      // Rows created from this template carry template_id inside additional_data —
      // move them to the matching trash table before deleting the template.
      const needle = `"template_id":"${id}"`;
      for (const t of ["tasks", "events", "repeat_tasks", "repeat_events"]) {
        try {
          const { results } = await db.prepare(
            `SELECT task_id FROM ${t} WHERE additional_data LIKE ?`
          ).bind(`%${needle}%`).all();
          const trash = t.includes("events") ? "trash_events" : "trash_tasks";
          for (const r of results || []) {
            try { await moveRow(db, t, trash, r.task_id); } catch { /* row may have vanished */ }
          }
        } catch { /* table/column may not exist */ }
      }
      await db.prepare("DELETE FROM templates WHERE template_id = ?").bind(id).run();
      return { deleted: true, template_id: id };
    }

    default:
      throw new Error(`Unknown tasks action: ${action}`);
  }
}

function safeParse(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

let templatesReady = false;
async function ensureTemplatesTable(db) {
  if (templatesReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS templates (
    template_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  templatesReady = true;
}
