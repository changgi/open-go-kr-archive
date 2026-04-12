import Link from "next/link";
import { OPP_SE_LABELS, formatDate } from "@/lib/types";

export default function DocumentCard({ doc }: { doc: any }) {
  const oppLabel = OPP_SE_LABELS[doc.opp_se_cd || ""] || doc.opp_se_cd || "-";
  const badgeColor =
    doc.opp_se_cd === "1"
      ? "bg-green-100 text-green-800"
      : doc.opp_se_cd === "2"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";

  return (
    <Link
      href={`/documents/${doc.prdctn_instt_regist_no}`}
      className="block bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 flex-1">
          {doc.info_sj || "(제목 없음)"}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {doc.doc_type && (
            <span className={`px-1.5 py-0.5 rounded text-xs ${
              doc.doc_type === '내부결재' ? 'bg-gray-100 text-gray-600' : 'bg-blue-50 text-blue-600'
            }`}>{doc.doc_type}</span>
          )}
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>
            {oppLabel}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>{doc.proc_instt_nm || "-"}</span>
        <span>{formatDate(doc.prdctn_dt)}</span>
        {doc.doc_no && <span>#{doc.doc_no}</span>}
        {doc.file_count > 0 && <span>파일 {doc.file_count}개</span>}
      </div>
      {doc.one_line_summary && (
        <p className="mt-1.5 text-xs text-gray-600 line-clamp-2 leading-relaxed">{doc.one_line_summary}</p>
      )}
      {doc.keywords && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {doc.keywords.split(',').slice(0, 3).map((kw: string, i: number) => kw.trim() && (
            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-gray-50 text-gray-500 rounded border">{kw.trim()}</span>
          ))}
        </div>
      )}
    </Link>
  );
}
