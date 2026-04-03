import { supabase } from "../lib/supabase.js";

export async function getRecentDocuments() {
  const { data, error } = await supabase
    .from("documents")
    .select("prdctn_instt_regist_no, info_sj, proc_instt_nm, prdctn_dt, opp_se_nm, collected_at")
    .order("collected_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(`Failed to fetch recent documents: ${error.message}`);
  return data ?? [];
}
