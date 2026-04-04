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
    const { data, error, count } = await supabase
      .from("documents")
      .select("id, info_sj", { count: "exact" })
      .limit(3);

    return NextResponse.json({
      ok: true,
      url: url.slice(0, 30) + "...",
      keyType: process.env.SUPABASE_SERVICE_ROLE_KEY ? "service" : "anon",
      count,
      dataLen: data?.length,
      error: error?.message,
      sample: data?.map((d: any) => d.info_sj?.slice(0, 30)),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message });
  }
}
