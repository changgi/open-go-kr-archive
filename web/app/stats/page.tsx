import { createServerSupabase } from "@/lib/supabase/server";
import { OPP_SE_LABELS } from "@/lib/types";
import {
  BarChartSection,
  PieChartSection,
  LineChartSection,
} from "@/components/StatsChart";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const supabase = createServerSupabase();

  // 기관별 분포 (상위 10)
  const { data: insttData } = await supabase
    .from("documents")
    .select("proc_instt_nm")
    .limit(1000);

  const insttCounts: Record<string, number> = {};
  (insttData || []).forEach((d: { proc_instt_nm: string | null }) => {
    const name = d.proc_instt_nm || "기타";
    insttCounts[name] = (insttCounts[name] || 0) + 1;
  });
  const insttChart = Object.entries(insttCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name: name.length > 10 ? name.slice(0, 10) + "..." : name, value }));

  // 공개구분별 비율
  const { data: oppData } = await supabase.from("documents").select("opp_se_cd");
  const oppCounts: Record<string, number> = {};
  (oppData || []).forEach((d: { opp_se_cd: string | null }) => {
    const code = d.opp_se_cd || "?";
    const label = OPP_SE_LABELS[code] || code;
    oppCounts[label] = (oppCounts[label] || 0) + 1;
  });
  const oppChart = Object.entries(oppCounts).map(([name, value]) => ({ name, value }));

  // 날짜별 수집 추이 (최근 30일)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { data: dateData } = await supabase
    .from("documents")
    .select("collected_at")
    .gte("collected_at", thirtyDaysAgo.toISOString());

  const dateCounts: Record<string, number> = {};
  (dateData || []).forEach((d: { collected_at: string }) => {
    const date = d.collected_at.slice(0, 10);
    dateCounts[date] = (dateCounts[date] || 0) + 1;
  });
  const dateChart = Object.entries(dateCounts)
    .sort()
    .map(([date, count]) => ({ date: date.slice(5), count }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">수집 통계</h1>

      {insttChart.length === 0 && oppChart.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500">아직 통계 데이터가 없습니다.</p>
          <p className="text-sm text-gray-400 mt-2">
            문서를 수집하면 통계가 표시됩니다.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <LineChartSection data={dateChart} title="날짜별 수집 추이 (최근 30일)" />
          </div>
          <BarChartSection data={insttChart} title="기관별 분포 (상위 10)" />
          <PieChartSection data={oppChart} title="공개구분별 비율" />
        </div>
      )}
    </div>
  );
}
