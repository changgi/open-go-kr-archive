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

  const document = doc as DocumentWithFiles & { prdctn_dt_raw?: string };
  const oppLabel = OPP_SE_LABELS[document.opp_se_cd || ""] || "-";
  const prdnDt = document.prdctn_dt_raw || (document.prdctn_dt ? document.prdctn_dt.replace(/-/g, '') + '000000' : '');
  // nstSeCd: 등록번호 앞 3자리가 더 정확 (INSTT_SE_CD가 'E'인 경우 있음)
  const nstSeCd = document.prdctn_instt_regist_no?.slice(0, 3) || document.instt_se_cd || '';
  const detailUrl = `https://www.open.go.kr/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${document.prdctn_instt_regist_no}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`;

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
          파일 목록 ({document.files.length}개)
        </h2>
        {document.files.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 text-center">
            첨부 파일이 없습니다.
          </p>
        ) : (
          <div className="divide-y">
            {document.files.map((f: any) => (
              <div key={f.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-primary-600 px-1.5 py-0.5 bg-primary-50 rounded">
                      {f.file_se_dc || "기타"}
                    </span>
                    {f.file_ext && (
                      <span className="text-xs font-mono text-gray-500 px-1.5 py-0.5 bg-gray-100 rounded">
                        {f.file_ext}
                      </span>
                    )}
                    <span className="text-sm text-gray-900">{f.file_nm}</span>
                    <span className="text-xs text-gray-400">
                      ({formatFileSize(f.file_byte_num)})
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {f.downloaded && (
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">
                        다운로드됨
                      </span>
                    )}
                    {f.is_archive && (
                      <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700">
                        압축파일
                      </span>
                    )}
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        f.file_opp_yn === "Y"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {f.file_opp_yn === "Y" ? "공개" : "비공개"}
                    </span>
                  </div>
                </div>
                {/* ZIP archive entries */}
                {f.archive_entries && (() => {
                  let entries: any[] = [];
                  try { entries = typeof f.archive_entries === 'string' ? JSON.parse(f.archive_entries) : f.archive_entries; } catch {}
                  const fileEntries = entries.filter((e: any) => !e.path?.endsWith('/'));
                  if (fileEntries.length === 0) return null;
                  return (
                    <div className="mt-2 ml-4 p-2 bg-gray-50 rounded text-xs">
                      <p className="font-medium text-gray-600 mb-1">ZIP 내부 ({fileEntries.length}개 파일)</p>
                      <ul className="space-y-0.5 text-gray-500">
                        {fileEntries.slice(0, 10).map((e: any, i: number) => (
                          <li key={i} className="font-mono">
                            {e.path} <span className="text-gray-400">({formatFileSize(e.size)})</span>
                          </li>
                        ))}
                        {fileEntries.length > 10 && (
                          <li className="text-gray-400">... 외 {fileEntries.length - 10}개</li>
                        )}
                      </ul>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
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
