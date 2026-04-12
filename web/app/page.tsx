import { createServerSupabase } from "@/lib/supabase/server";
import DocumentCard from "@/components/DocumentCard";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = createServerSupabase();

  let recent: any[] = [];
  let total = 0;
  let todayTotal = 0;

  try {
    const recentRes = await supabase
      .from("documents")
      .select("*", { count: "exact" })
      .order("collected_at", { ascending: false })
      .limit(10);
    recent = recentRes.data || [];
    total = recentRes.count ?? 0;
  } catch {}

  try {
    const todayStr = new Date().toISOString().slice(0, 10) + "T00:00:00";
    const todayRes = await supabase
      .from("documents")
      .select("prdctn_instt_regist_no", { count: "exact", head: true })
      .gte("collected_at", todayStr);
    todayTotal = todayRes.count ?? 0;
  } catch {}

  return (
    <div className="space-y-8">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <p className="text-sm text-gray-500">총 수집 문서</p>
          <p className="text-3xl font-bold text-primary-600 mt-1">
            {total.toLocaleString()}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <p className="text-sm text-gray-500">오늘 수집</p>
          <p className="text-3xl font-bold text-primary-600 mt-1">
            {Number(todayTotal).toLocaleString()}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <p className="text-sm text-gray-500">상태</p>
          <p className="text-lg font-medium text-green-600 mt-1">
            수집 중
          </p>
        </div>
      </div>

      {/* Recent Documents */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">최근 수집 문서</h2>
          <Link
            href="/documents"
            className="text-sm text-primary-600 hover:underline"
          >
            전체 보기
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <p className="text-gray-500 mb-4">아직 수집된 문서가 없습니다.</p>
            <p className="text-sm text-gray-400">
              수집기를 실행하여 문서를 수집하세요.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {recent.map((doc: any) => (
              <DocumentCard key={doc.prdctn_instt_regist_no} doc={doc} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
