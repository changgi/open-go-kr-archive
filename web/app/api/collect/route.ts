import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  // Verify CRON_SECRET
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { keyword = "", startDate, endDate, maxCount = 50 } = body;

    const supabase = createServerSupabase();

    // Create a collection run record
    const { data: run, error } = await supabase
      .from("collection_runs")
      .insert({
        keyword: keyword || null,
        start_date: startDate || null,
        end_date: endDate || null,
        status: "running",
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Note: The actual collection is triggered via GitHub Actions or
    // by running the Python collector directly. This endpoint creates
    // a run record and could trigger the workflow via GitHub API.
    return NextResponse.json({
      success: true,
      runId: run.id,
      message: "Collection run created. Trigger the Python collector to start collecting.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Vercel Cron calls GET
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerSupabase();
  const { data: run } = await supabase
    .from("collection_runs")
    .insert({ status: "running" })
    .select()
    .single();

  return NextResponse.json({
    success: true,
    runId: run?.id,
    message: "Cron-triggered collection run created.",
  });
}
