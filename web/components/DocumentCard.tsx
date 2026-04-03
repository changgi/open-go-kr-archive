import Link from "next/link";
import { Document, OPP_SE_LABELS, formatDate } from "@/lib/types";

export default function DocumentCard({ doc }: { doc: Document }) {
  const oppLabel = OPP_SE_LABELS[doc.opp_se_cd || ""] || doc.opp_se_cd || "-";
  const badgeColor =
    doc.opp_se_cd === "1"
      ? "bg-green-100 text-green-800"
      : doc.opp_se_cd === "2"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-red-100 text-red-800";

  return (
    <Link
      href={`/documents/${doc.id}`}
      className="block bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 flex-1">
          {doc.info_sj || "(제목 없음)"}
        </h3>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>
          {oppLabel}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>{doc.proc_instt_nm || "-"}</span>
        <span>{formatDate(doc.prdctn_dt)}</span>
        {doc.doc_no && <span>#{doc.doc_no}</span>}
      </div>
    </Link>
  );
}
