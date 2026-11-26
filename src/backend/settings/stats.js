import { fetchCloudflareLimits } from "../ai/limits.js";
import { getStorageStats } from "../database/storage_stats.js";

// D1 databases holding the app data. `timetable` is the tasks/events DB.
const D1_DATABASES = [
  { key: "tasks", label: "Tasks & événements", binding: "timetable", capacityGB: 5 },
];

// Real on-disk size of a D1 database via PRAGMA page_count × page_size.
async function d1SizeBytes(db) {
  const [pages, size] = await Promise.all([
    db.prepare("PRAGMA page_count").first(),
    db.prepare("PRAGMA page_size").first(),
  ]);
  return (Number(pages?.page_count) || 0) * (Number(size?.page_size) || 0);
}

async function getD1Stats(env) {
  const items = [];
  let totalBytes = 0;
  for (const def of D1_DATABASES) {
    const db = env[def.binding];
    let bytes = 0;
    if (db) {
      try {
        bytes = await d1SizeBytes(db);
      } catch (error) {
        console.error(`Error sizing D1 ${def.binding}:`, error);
      }
    }
    totalBytes += bytes;
    items.push({ key: def.key, label: def.label, bytes });
  }
  return {
    totalBytes,
    capacityGB: D1_DATABASES[0]?.capacityGB || 5,
    items,
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
          unit: "neurons"
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
        capacityGB: 5,
        items: [{ key: "tasks", label: "Tasks & événements", bytes: 0 }]
      }
    };
  }
}
