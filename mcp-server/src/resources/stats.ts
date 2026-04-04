import { getCollectionStats } from "../tools/stats.js";

export async function getStatsResource() {
  return await getCollectionStats();
}
