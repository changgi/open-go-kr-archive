import { createServerSupabase } from "@/lib/supabase/server";
import { DocumentWithFiles, OPP_SE_LABELS, formatDate, formatFileSize } from "@/lib/types";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: { id: string };
}

export default async function DocumentDetailPage({ params }: Props) {
  const supabase = createServerSupabase();

  const { data: doc } = await supabase
    .from("documents")
    .select("*, files(*)")
    .eq("id", params.id)
    .single();

  if (!doc) notFound();

  const document = doc as DocumentWithFiles;
  const oppLabel = OPP_SE_LABELS[document.opp_se_cd || ""] || "-";
  const detailUrl = `https://www.open.go.kr/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${document.prdctn_instt_regist_no}`;

  const metaRows = [
    ["제목", document.info_sj],
    ["문서번호", document.doc_no],
    ["기관명", document.proc_instt_nm],
    ["담당부서", document.chrg_dept_nm],
    ["담당자", document.charger_nm],
    ["생산일자", formatDate(document.prdctn_dt)],
    ["보존기간", document.prsrv_pd_cd],
    ["단위업무", document.unit_job_nm],
    ["공개여부", oppLabel],
    ["분류체계", document.nst_cl_nm],
    ["원문등록번호", document.prdctn_instt_regist_no],
    ["열람제한일", document.dta_redg_lmtt_end_ymd || "-"],
    ["수집일시", new Date(document.collected_at).toLocaleString("ko-KR")],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/documents" className="hover:text-primary-600">
          문서 목록
        </Link>
        <span>/</span>
        <span className="text-gray-900">상세</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900">
        {document.info_sj || "(제목 없음)"}
      </h1>

      {/* Metadata Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">
          메타데이터
        </h2>
        <table className="w-full text-sm">
          <tbody>
            {metaRows.map(([label, value]) => (
              <tr key={label} className="border-b last:border-0">
                <td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-32">
                  {label}
                </td>
                <td className="px-4 py-2.5 text-gray-900">{value || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Files */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">
          파일 목록
        </h2>
        {document.files.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 text-center">
            첨부 파일이 없습니다.
          </p>
        ) : (
          <ul className="divide-y">
            {document.files.map((f) => (
              <li key={f.id} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-primary-600 mr-2">
                    {f.file_se_dc || "기타"}
                  </span>
                  <span className="text-sm text-gray-900">{f.file_nm}</span>
                  <span className="text-xs text-gray-400 ml-2">
                    ({formatFileSize(f.file_byte_num)})
                  </span>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    f.file_opp_yn === "Y"
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {f.file_opp_yn === "Y" ? "공개" : "비공개"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Original Link */}
      <a
        href={detailUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
      >
        원문 사이트에서 보기
      </a>
    </div>
  );
}
