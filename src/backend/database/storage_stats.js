import { megaStats } from "../mega_client.js";

// Storage usage is computed inside mega-client-worker (it owns the MEGA
// session). This worker just relays the numbers.
export async function getStorageStats(env) {
  try {
    const stats = await megaStats(env, "files");
    return {
      totalBytes: stats.totalBytes || 0,
      capacityGB: stats.capacityGB || 20,
      items: stats.items || [
        { key: "files/", label: "lumaris/files/", bytes: 0 },
      ]
    };
  } catch (error) {
    console.error("Error fetching storage stats:", error);
    return {
      totalBytes: 0,
      capacityGB: 20,
      items: [
        { key: "files/", label: "lumaris/files/", bytes: 0 },
      ]
    };
  }
}
