import { supabase } from "../lib/supabase.js";

export async function getCollectionStats() {
  const { count: totalDocs } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true });

  const { count: totalFiles } = await supabase
    .from("files")
    .select("*", { count: "exact", head: true });

  const { data: topInstitutions } = await supabase.rpc("get_top_institutions");

  // Fallback if RPC not available: raw query via simple group
  let institutionStats = topInstitutions;
  if (!institutionStats) {
    const { data } = await supabase
      .from("documents")
      .select("proc_instt_nm")
      .not("proc_instt_nm", "is", null);

    if (data) {
      const counts = new Map<string, number>();
      for (const row of data) {
        const name = row.proc_instt_nm ?? "unknown";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      institutionStats = Array.from(counts.entries())
        .map(([name, count]) => ({ proc_instt_nm: name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }
  }

  const { data: recentRuns } = await supabase
    .from("collection_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(5);

  return {
    totalDocuments: totalDocs ?? 0,
    totalFiles: totalFiles ?? 0,
    topInstitutions: institutionStats ?? [],
    recentRuns: recentRuns ?? [],
  };
}
