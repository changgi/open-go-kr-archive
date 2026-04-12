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

  // 기관별 분포 (상위 10) — RPC 대신 클라이언트 집계
  let insttChart: { name: string; value: number }[] = [];
  let oppChart: { name: string; value: number }[] = [];
  let dateChart: { date: string; count: number }[] = [];

  try {
    const { data: insttData } = await supabase
      .from("documents")
      .select("proc_instt_nm")
      .not("proc_instt_nm", "is", null)
      .limit(2000);

    const insttCounts: Record<string, number> = {};
    (insttData || []).forEach((d: any) => {
      const name = d.proc_instt_nm || "기타";
      insttCounts[name] = (insttCounts[name] || 0) + 1;
    });
    insttChart = Object.entries(insttCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, value]) => ({ name: name.length > 10 ? name.slice(0, 10) + "..." : name, value }));
  } catch {}

  try {
    // 공개구분별 비율
    const { data: oppData } = await supabase
      .from("documents")
      .select("opp_se_cd")
      .not("opp_se_cd", "is", null)
      .limit(5000);

    const oppCounts: Record<string, number> = {};
    (oppData || []).forEach((d: any) => {
      const code = d.opp_se_cd || "?";
      const label = OPP_SE_LABELS[code] || code;
      oppCounts[label] = (oppCounts[label] || 0) + 1;
    });
    oppChart = Object.entries(oppCounts).map(([name, value]) => ({ name, value }));
  } catch {}

  try {
    // 날짜별 수집 추이 (최근 30일)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data: dateData } = await supabase
      .from("documents")
      .select("collected_at")
      .gte("collected_at", thirtyDaysAgo.toISOString())
      .limit(5000);

    const dateCounts: Record<string, number> = {};
    (dateData || []).forEach((d: any) => {
      if (d.collected_at) {
        const date = d.collected_at.slice(0, 10);
        dateCounts[date] = (dateCounts[date] || 0) + 1;
      }
    });
    dateChart = Object.entries(dateCounts)
      .sort()
      .map(([date, count]) => ({ date: date.slice(5), count }));
  } catch {}

  // 전체 건수
  let totalCount = 0;
  try {
    const { count } = await supabase
      .from("documents")
      .select("prdctn_instt_regist_no", { count: "exact", head: true });
    totalCount = count || 0;
  } catch {}

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">수집 통계</h1>

      <div className="bg-white rounded-lg shadow-sm border p-6">
        <p className="text-sm text-gray-500">총 수집 문서</p>
        <p className="text-3xl font-bold text-primary-600 mt-1">{totalCount.toLocaleString()}건</p>
      </div>

      {insttChart.length === 0 && oppChart.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500">아직 통계 데이터가 없습니다.</p>
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
