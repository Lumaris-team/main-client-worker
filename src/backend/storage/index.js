// Storage API — backed by the `storage` D1 database.
// Tables: "artificial-intelligence" (deleted/censored AI conversations)
//         files (MEGA-backed file metadata — id = MEGA node ID, the value
//         referenced by attachments_id on tasks/subjects/chapters).
//
// Files themselves live on MEGA via mega-client-worker; this database only
// keeps the lightweight metadata needed to resolve attachments without
// loading file content.

const FILES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  last_modified TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const AI_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "artificial-intelligence" (
  conversation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'deleted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

let tablesReady = false;

async function ensureStorageTables(db) {
  if (tablesReady) return;
  await db.prepare(FILES_TABLE_SQL).run();
  await db.prepare(AI_TABLE_SQL).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_files_name ON files(name)").run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ai_status ON "artificial-intelligence"(status)').run();
  tablesReady = true;
}

function normalizeSlashes(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// path stored in DB is lumaris/-relative, e.g. "files/attachments/tasks/x.pdf"
export async function registerFile(env, { id, path, name, size }) {
  if (!env.storage || !id) return;
  const db = env.storage;
  await ensureStorageTables(db);
  const cleanPath = normalizeSlashes(path);
  const cleanName = String(name || cleanPath.split("/").pop() || "").slice(0, 255);
  await db
    .prepare(
      `INSERT INTO files (id, path, name, size, last_modified)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         name = excluded.name,
         size = excluded.size,
         last_modified = excluded.last_modified`
    )
    .bind(String(id), cleanPath, cleanName, Number(size) || 0, new Date().toISOString())
    .run();
}

export async function removeFileByPath(env, path) {
  if (!env.storage) return;
  const db = env.storage;
  await ensureStorageTables(db);
  await db.prepare("DELETE FROM files WHERE path = ?").bind(normalizeSlashes(path)).run();
}

export async function renameFileRow(env, oldPath, newPath, newName) {
  if (!env.storage) return;
  const db = env.storage;
  await ensureStorageTables(db);
  await db
    .prepare("UPDATE files SET path = ?, name = ? WHERE path = ?")
    .bind(normalizeSlashes(newPath), String(newName || "").slice(0, 255), normalizeSlashes(oldPath))
    .run();
}

export async function lookupFiles(env, ids) {
  if (!env.storage) return { files: [] };
  const db = env.storage;
  await ensureStorageTables(db);
  const clean = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 200);
  if (!clean.length) return { files: [] };
  const placeholders = clean.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT id, path, name, size, last_modified, created FROM files WHERE id IN (${placeholders})`)
    .bind(...clean)
    .all();
  return { files: results || [] };
}

export async function StorageFunction(env, path, method, body) {
  if (method === "POST" && path === "files/lookup") {
    return await lookupFiles(env, body?.ids);
  }
  throw new Error("Invalid storage path");
}
