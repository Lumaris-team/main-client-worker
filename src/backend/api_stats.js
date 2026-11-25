import { megaStats } from "./mega_client.js";

const STORAGE_PATHS = [
  { key: "files/", label: "Files" },
];

export async function StatsFunction(env) {
  const results = [];
  let totalBytes = 0;

  for (const item of STORAGE_PATHS) {
    try {
      const stats = await megaStats(env, item.key.replace(/\/$/, ""));
      const size = stats.totalBytes || 0;
      totalBytes += size;
      results.push({
        key: item.key,
        label: item.label,
        bytes: size,
      });
    } catch (error) {
      console.error(`Error fetching size for ${item.key}:`, error);
      results.push({
        key: item.key,
        label: item.label,
        bytes: 0,
      });
    }
  }

  return {
    aiUsage: {
      used: 12,
      limit: 20,
    },
    storage: {
      totalBytes,
      capacityGB: 20,
      items: results,
    },
  };
}
