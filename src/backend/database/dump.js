// Full D1 dump — read-only export of every table in every database,
// used by the iOS app to mirror all data locally for offline access.
// GET /api/dump → { databases: { timetable: { tasks: [...], ... }, ... } }

const D1_BINDINGS = ["timetable", "subjects_data", "school_data", "emails", "settings", "storage"];
const ROW_LIMIT = 100000;

async function dumpDatabase(db) {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
    .all();
  const out = {};
  for (const { name } of tables ?? []) {
    try {
      const { results } = await db
        .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT ${ROW_LIMIT}`)
        .all();
      out[name] = results ?? [];
    } catch (e) {
      out[name] = { error: e?.message || String(e) };
    }
  }
  return out;
}

export async function DumpFunction(env, method) {
  if (method !== "GET") return { error: "method not allowed" };
  const databases = {};
  await Promise.all(D1_BINDINGS.map(async (key) => {
    const db = env[key];
    if (!db) { databases[key] = { error: "binding missing" }; return; }
    try {
      databases[key] = await dumpDatabase(db);
    } catch (e) {
      databases[key] = { error: e?.message || String(e) };
    }
  }));
  return { databases, dumped_at: new Date().toISOString() };
}
