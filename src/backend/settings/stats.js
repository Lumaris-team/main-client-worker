import { fetchCloudflareLimits } from "../ai/limits.js";
import { getStorageStats } from "../database/storage_stats.js";

// D1 databases holding the app data. `timetable` is the tasks/events DB,
// `subjects_data` holds subjects & chapters.
const D1_DATABASES = [
  { key: "timetable", label: "Tâches & événements", binding: "timetable", capacityGB: 5 },
  { key: "subjects_data", label: "Matières & chapitres", binding: "subjects_data", capacityGB: 5 },
];

// Friendly French labels for known tables; unknown tables keep their name.
const TABLE_LABELS = {
  tasks: "Tâches",
  repeat_tasks: "Tâches récurrentes",
  events: "Événements",
  repeat_events: "Événements récurrents",
  trash: "Corbeille",
  trash_events: "Corbeille (événements)",
  subjects: "Matières",
  chapters: "Chapitres",
  labels: "Étiquettes",
  flags: "Drapeaux",
  types: "Types",
  methods: "Méthodes",
  priorities: "Priorités",
  attention: "Niveaux d'attention",
  folders: "Dossiers",
  templates: "Templates",
};

const tableLabel = (name) => TABLE_LABELS[name] || name;

// Real on-disk size of a D1 database via PRAGMA page_count × page_size.
async function d1SizeBytes(db) {
  const [pages, size] = await Promise.all([
    db.prepare("PRAGMA page_count").first(),
    db.prepare("PRAGMA page_size").first(),
  ]);
  return (Number(pages?.page_count) || 0) * (Number(size?.page_size) || 0);
}

// Per-table sizes via the dbstat virtual table (pgsize = bytes on disk,
// including indexes). Returns [] when dbstat is unavailable.
async function d1TableSizes(db) {
  try {
    const { results } = await db.prepare(
      `SELECT name, SUM(pgsize) AS bytes
       FROM dbstat
       WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'cf_%'
       GROUP BY name`
    ).all();
    return (results || [])
      .map((r) => ({ key: r.name, label: tableLabel(r.name), bytes: Number(r.bytes) || 0 }))
      .filter((t) => t.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

async function getD1Stats(env) {
  const items = [];
  const tables = [];
  let totalBytes = 0;
  let capacityGB = 0;

  for (const def of D1_DATABASES) {
    const db = env[def.binding];
    let bytes = 0;
    let dbTables = [];
    if (db) {
      try {
        [bytes, dbTables] = await Promise.all([d1SizeBytes(db), d1TableSizes(db)]);
      } catch (error) {
        console.error(`Error sizing D1 ${def.binding}:`, error);
      }
    }
    totalBytes += bytes;
    capacityGB += def.capacityGB;
    items.push({ key: def.key, label: def.label, bytes, tables: dbTables });
    for (const t of dbTables) tables.push({ ...t, db: def.key });
  }

  return {
    totalBytes,
    capacityGB,
    items,
    // Flat per-table list for the frontend breakdown (Tâches, Matières, Chapitres…)
    tables: tables.sort((a, b) => b.bytes - a.bytes),
  };
}

export async function StatsFunction(env) {
  try {
    // Fetch AI usage limits
    const aiStats = await fetchCloudflareLimits(env);

    // Fetch storage statistics (MEGA files + D1 databases)
    const storageStats = await getStorageStats(env);
    const d1Stats = await getD1Stats(env);

    return {
      ai: aiStats,
      storage: storageStats,
      d1: d1Stats
    };
  } catch (error) {
    console.error("Error fetching stats:", error);
    return {
      ai: {
        daily: {
          used: 0,
          limit: 10000,
          percentage: 0,
          unit: "neurones"
        },
        models: []
      },
      storage: {
        totalBytes: 0,
        capacityGB: 20,
        items: [
          { key: "files/", label: "lumaris/files/", bytes: 0 },
        ]
      },
      d1: {
        totalBytes: 0,
        capacityGB: 10,
        items: [
          { key: "timetable", label: "Tâches & événements", bytes: 0, tables: [] },
          { key: "subjects_data", label: "Matières & chapitres", bytes: 0, tables: [] },
        ],
        tables: []
      }
    };
  }
}
