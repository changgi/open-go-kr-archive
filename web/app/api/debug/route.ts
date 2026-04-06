import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return NextResponse.json({
      error: "Missing env vars",
      hasUrl: !!url,
      hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
  }

  try {
    const supabase = createServerSupabase();

    // Test exact same query as documents page
    const { data: docs, error: docsErr, count } = await supabase
      .from("documents")
      .select("*", { count: "exact" })
      .order("collected_at", { ascending: false })
      .limit(20);

    // Test stats query
    const { data: statsData, error: statsErr } = await supabase
      .from("documents")
      .select("proc_instt_nm")
      .not("proc_instt_nm", "is", null);

    return NextResponse.json({
      ok: true,
      url: url.slice(0, 30) + "...",
      keyType: process.env.SUPABASE_SERVICE_ROLE_KEY ? "service" : "anon",
      docsCount: count,
      docsLen: docs?.length,
      docsErr: docsErr?.message,
      statsLen: statsData?.length,
      statsErr: statsErr?.message,
      sample: docs?.map((d: any) => ({ title: d.info_sj?.slice(0, 30), opp: d.opp_se_nm })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message });
  }
}
