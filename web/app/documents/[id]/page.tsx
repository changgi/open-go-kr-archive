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
            {document.files.map((f: any, idx: number) => {
              let props: any = {};
              try { props = typeof f.file_properties === 'string' ? JSON.parse(f.file_properties) : (f.file_properties || {}); } catch {}
              let archiveEntries: any[] = [];
              try { archiveEntries = typeof f.archive_entries === 'string' ? JSON.parse(f.archive_entries) : (f.archive_entries || []); } catch {}
              const fileEntries = archiveEntries.filter((e: any) => !e.path?.endsWith('/'));

              return (
                <div key={f.id} className="px-4 py-4">
                  {/* Header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-white px-2 py-0.5 bg-primary-600 rounded">
                        {f.file_se_dc || "기타"}
                      </span>
                      {f.file_ext && (
                        <span className="text-xs font-mono text-gray-600 px-1.5 py-0.5 bg-gray-100 rounded border">
                          {f.file_ext}
                        </span>
                      )}
                      <span className="text-sm font-medium text-gray-900">{f.file_nm}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {f.download_url ? (
                        <a
                          href={f.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs px-3 py-1 rounded bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                        >
                          다운로드
                        </a>
                      ) : f.downloaded ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">수집됨</span>
                      ) : null}
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        f.file_opp_yn === "Y" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                      }`}>
                        {f.file_opp_yn === "Y" ? "공개" : "비공개"}
                      </span>
                    </div>
                  </div>

                  {/* File attributes table */}
                  <div className="ml-2 bg-gray-50 rounded p-3 text-xs">
                    <table className="w-full">
                      <tbody className="divide-y divide-gray-200">
                        <tr><td className="py-1 text-gray-500 w-32">크기</td><td className="py-1">{formatFileSize(f.file_byte_num)} ({Number(f.file_byte_num || 0).toLocaleString()} bytes)</td></tr>
                        {props.mime_type && <tr><td className="py-1 text-gray-500">MIME 타입</td><td className="py-1 font-mono">{props.mime_type}</td></tr>}
                        {props.pdf_version && <tr><td className="py-1 text-gray-500">PDF 버전</td><td className="py-1">{props.pdf_version}</td></tr>}
                        {props.page_count && <tr><td className="py-1 text-gray-500">페이지 수</td><td className="py-1">{props.page_count}</td></tr>}
                        {props.image_width && <tr><td className="py-1 text-gray-500">이미지 크기</td><td className="py-1">{props.image_width} x {props.image_height}px</td></tr>}
                        {props.dpi_x && <tr><td className="py-1 text-gray-500">해상도</td><td className="py-1">{props.dpi_x} x {props.dpi_y} DPI</td></tr>}
                        {props.bit_depth && <tr><td className="py-1 text-gray-500">비트 수준</td><td className="py-1">{props.bit_depth}bit</td></tr>}
                        {props.camera_make && <tr><td className="py-1 text-gray-500">카메라</td><td className="py-1">{props.camera_make} {props.camera_model}</td></tr>}
                        {props.scanner_make && <tr><td className="py-1 text-gray-500">스캐너</td><td className="py-1">{props.scanner_make} {props.scanner_model}</td></tr>}
                        {props.software && <tr><td className="py-1 text-gray-500">소프트웨어</td><td className="py-1">{props.software}</td></tr>}
                        {props.date_taken && <tr><td className="py-1 text-gray-500">촬영일</td><td className="py-1">{props.date_taken}</td></tr>}
                        {props.format && <tr><td className="py-1 text-gray-500">포맷</td><td className="py-1">{props.format}</td></tr>}
                        {props.duration_seconds && <tr><td className="py-1 text-gray-500">영상 길이</td><td className="py-1">{props.duration_seconds}초</td></tr>}
                        {props.video_width && <tr><td className="py-1 text-gray-500">영상 크기</td><td className="py-1">{props.video_width} x {props.video_height}px</td></tr>}
                        {f.is_archive && <tr><td className="py-1 text-gray-500">압축파일</td><td className="py-1 text-purple-700 font-medium">예</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  {/* ZIP archive tree */}
                  {fileEntries.length > 0 && (
                    <div className="mt-2 ml-2 p-3 bg-purple-50 rounded text-xs border border-purple-100">
                      <p className="font-semibold text-purple-700 mb-2">ZIP 내부 구조 ({fileEntries.length}개 파일)</p>
                      <div className="font-mono text-gray-600 space-y-0.5 max-h-48 overflow-y-auto">
                        {fileEntries.slice(0, 20).map((e: any, i: number) => (
                          <div key={i} className="flex justify-between">
                            <span>{e.path}</span>
                            <span className="text-gray-400 ml-4 shrink-0">{formatFileSize(e.size)} | {e.modified}</span>
                          </div>
                        ))}
                        {fileEntries.length > 20 && (
                          <div className="text-purple-500 mt-1">... 외 {fileEntries.length - 20}개</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* File content summary */}
                  {f.summary && (
                    <div className="mt-2 ml-2 p-3 bg-amber-50 rounded text-xs border border-amber-100">
                      <p className="font-semibold text-amber-700 mb-1">내용 요약</p>
                      <p className="text-gray-700 leading-relaxed">{f.summary}</p>
                    </div>
                  )}

                  {/* File full content (collapsible) */}
                  {f.content && (
                    <details className="mt-2 ml-2">
                      <summary className="text-xs text-primary-600 cursor-pointer hover:underline">
                        전체 내용 보기 ({f.content_length?.toLocaleString() || f.content.length.toLocaleString()}자)
                      </summary>
                      <div className="mt-1 p-3 bg-gray-50 rounded text-xs border max-h-96 overflow-y-auto">
                        <pre className="whitespace-pre-wrap text-gray-700 font-sans leading-relaxed">
                          {f.content.slice(0, 10000)}
                          {f.content.length > 10000 && `\n\n... (${f.content.length.toLocaleString()}자 중 10,000자 표시)`}
                        </pre>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
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
