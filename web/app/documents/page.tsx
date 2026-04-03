import { createServerSupabase } from "@/lib/supabase/server";
import { Document } from "@/lib/types";
import DocumentCard from "@/components/DocumentCard";
import SearchBar from "@/components/SearchBar";
import Pagination from "@/components/Pagination";
import { Suspense } from "react";

const PAGE_SIZE = 20;

interface Props {
  searchParams: { q?: string; page?: string; opp?: string; instt?: string };
}

export default async function DocumentsPage({ searchParams }: Props) {
  const supabase = createServerSupabase();
  const page = Math.max(1, parseInt(searchParams.page || "1"));
  const keyword = searchParams.q || "";
  const oppFilter = searchParams.opp || "";
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from("documents")
    .select("*", { count: "exact" })
    .order("collected_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (keyword) {
    query = query.or(
      `info_sj.ilike.%${keyword}%,proc_instt_nm.ilike.%${keyword}%,doc_no.ilike.%${keyword}%`
    );
  }
  if (oppFilter) {
    query = query.eq("opp_se_cd", oppFilter);
  }

  const { data, count } = await query;
  const docs = (data || []) as Document[];
  const totalPages = Math.ceil((count || 0) / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">문서 목록</h1>

      <Suspense fallback={<div className="h-10 bg-gray-100 rounded animate-pulse" />}>
        <SearchBar />
      </Suspense>

      {/* Filters */}
      <div className="flex gap-2 text-sm">
        {["", "1", "2", "3", "5"].map((code) => {
          const labels: Record<string, string> = {
            "": "전체",
            "1": "공개",
            "2": "부분공개",
            "3": "비공개",
            "5": "열람제한",
          };
          const isActive = oppFilter === code;
          return (
            <a
              key={code}
              href={`/documents?q=${keyword}&opp=${code}&page=1`}
              className={`px-3 py-1.5 rounded-full border ${
                isActive
                  ? "bg-primary-600 text-white border-primary-600"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100"
              }`}
            >
              {labels[code]}
            </a>
          );
        })}
      </div>

      {/* Results */}
      <div className="text-sm text-gray-500">
        총 {(count || 0).toLocaleString()}건
      </div>

      {docs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500">검색 결과가 없습니다.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {docs.map((doc) => (
            <DocumentCard key={doc.id} doc={doc} />
          ))}
        </div>
      )}

      <Suspense>
        <Pagination currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}
