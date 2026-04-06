import { createServerSupabase } from "@/lib/supabase/server";
import { OPP_SE_LABELS, formatDate, formatFileSize } from "@/lib/types";
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
  const d: any = doc;
  const oppLabel = OPP_SE_LABELS[d.opp_se_cd || ""] || d.opp_se_cd || "-";
  const detailUrl = d.original_url || `https://www.open.go.kr/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${d.prdctn_instt_regist_no}`;

  // Parse JSON fields
  let approvalChain: any[] = [];
  try { approvalChain = typeof d.approval_chain === 'string' ? JSON.parse(d.approval_chain) : (d.approval_chain || []); } catch {}
  let contactInfo: any = {};
  try { contactInfo = typeof d.contact_info === 'string' ? JSON.parse(d.contact_info) : (d.contact_info || {}); } catch {}

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/documents" className="hover:text-primary-600">문서 목록</Link>
        <span>/</span>
        <span className="text-gray-900">상세</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900">{d.info_sj || "(제목 없음)"}</h1>

      {/* Document type + status badges */}
      <div className="flex flex-wrap gap-2">
        {d.doc_type && (
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
            d.doc_type === '내부결재' ? 'bg-gray-200 text-gray-700' : 'bg-blue-100 text-blue-700'
          }`}>{d.doc_type}</span>
        )}
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
          d.opp_se_cd === '1' ? 'bg-green-100 text-green-700' :
          d.opp_se_cd === '2' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
        }`}>{oppLabel}</span>
        {d.file_count > 0 && (
          <span className="text-xs px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">
            파일 {d.file_count}개 (다운로드 {d.downloaded_count || 0}개)
          </span>
        )}
      </div>

      {/* 문서 기본 정보 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">문서 기본 정보</h2>
        <table className="w-full text-sm">
          <tbody>
            {[
              ["제목", d.info_sj],
              ["문서번호", d.doc_no],
              ["기관명", d.proc_instt_nm],
              ["소속 전체명", d.full_dept_nm],
              ["담당부서", d.chrg_dept_nm],
              ["담당자", d.charger_nm],
              ["생산일자", formatDate(d.prdctn_dt)],
              ["보존기간", d.prsrv_pd_cd],
              ["단위업무", d.unit_job_nm],
              ["공개여부", oppLabel],
              ["분류체계", d.nst_cl_nm],
              ["원문등록번호", d.prdctn_instt_regist_no],
              ["열람제한일", d.dta_redg_lmtt_end_ymd],
              ["수집일시", d.collected_at ? new Date(d.collected_at).toLocaleString("ko-KR") : "-"],
            ].filter(([, v]) => v && v !== "-").map(([label, value]) => (
              <tr key={label as string} className="border-b last:border-0">
                <td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">{label}</td>
                <td className="px-4 py-2.5 text-gray-900">{value || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 발신/수신처 */}
      {(d.sender_info || d.receiver_info || d.doc_type) && (() => {
        let sender: any = {};
        let receiver: any = {};
        try { sender = typeof d.sender_info === 'string' ? JSON.parse(d.sender_info) : (d.sender_info || {}); } catch {}
        try { receiver = typeof d.receiver_info === 'string' ? JSON.parse(d.receiver_info) : (d.receiver_info || {}); } catch {}
        const hasSender = sender.org || d.proc_instt_nm;
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">
              발신 / 수신 {d.doc_type && <span className={`ml-2 text-xs px-2 py-0.5 rounded ${d.doc_type === '내부결재' ? 'bg-gray-200' : 'bg-blue-100 text-blue-700'}`}>{d.doc_type}</span>}
            </h2>
            <div className="p-4">
              <div className="flex items-center gap-4">
                {/* 발신 */}
                <div className="flex-1 p-3 bg-blue-50 rounded-lg border border-blue-100">
                  <p className="text-xs text-blue-600 font-semibold mb-1">발신 (From)</p>
                  <p className="text-sm font-medium text-gray-900">{sender.org || d.proc_instt_nm || '-'}</p>
                  {sender.dept && <p className="text-xs text-gray-600">{sender.dept}</p>}
                  {sender.person && <p className="text-xs text-gray-500">{sender.role ? `${sender.role} ` : ''}{sender.person}</p>}
                </div>
                {/* 화살표 */}
                <span className="text-2xl text-gray-300 shrink-0">→</span>
                {/* 수신 */}
                <div className="flex-1 p-3 bg-green-50 rounded-lg border border-green-100">
                  <p className="text-xs text-green-600 font-semibold mb-1">수신 (To)</p>
                  <p className="text-sm font-medium text-gray-900">{receiver.org || d.recipient || (d.doc_type === '내부결재' ? (d.proc_instt_nm || '내부결재') : '-')}</p>
                  {receiver.dept && <p className="text-xs text-gray-600">{receiver.dept}</p>}
                  {(receiver.person || receiver.role) && (
                    <p className="text-xs text-gray-500 font-medium">
                      {receiver.role ? `${receiver.role} ` : ''}{receiver.person}
                      {d.doc_type === '내부결재' && <span className="ml-1 text-green-600">(최종결재자)</span>}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 문서 내용 요약 (AI 6하원칙 + 핵심내용 통합) */}
      {(d.ai_summary || d.body_summary) && (() => {
        let w: any = {};
        try { w = typeof d.ai_summary === 'string' ? JSON.parse(d.ai_summary) : (d.ai_summary || {}); } catch {}

        // body_summary에서 핵심내용 추출
        let coreContent = '';
        if (d.body_summary) {
          const match = d.body_summary.match(/## 핵심 내용\n\n([\s\S]*?)(?=\n## |$)/);
          if (match) coreContent = match[1].trim();
        }

        return (
          <div className="bg-white rounded-lg shadow-sm border border-amber-200 overflow-hidden">
            <h2 className="px-4 py-3 bg-amber-50 font-semibold text-sm text-amber-800 border-b border-amber-100">문서 내용 요약</h2>
            <div className="p-4 space-y-4">
              {/* 6하원칙 테이블 */}
              {(w.who || w.what) && (
                <div>
                  <h3 className="text-xs font-semibold text-amber-700 mb-2">6하원칙 분석</h3>
                  <table className="w-full text-sm border border-amber-100 rounded">
                    <tbody>
                      {w.who && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">누가</td><td className="px-3 py-2">{w.who}</td></tr>}
                      {w.to_whom && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">누구에게</td><td className="px-3 py-2">{w.to_whom}</td></tr>}
                      {w.when && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">언제</td><td className="px-3 py-2">{w.when}</td></tr>}
                      {w.where && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">어디서</td><td className="px-3 py-2">{w.where}</td></tr>}
                      {w.what && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">무엇을</td><td className="px-3 py-2">{w.what}</td></tr>}
                      {w.why && <tr className="border-b border-amber-50"><td className="px-3 py-2 font-medium text-amber-700 bg-amber-50/50 w-28">왜</td><td className="px-3 py-2">{w.why}</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              {/* 한줄 요약 */}
              {w.one_line && (
                <div className="px-3 py-2.5 bg-amber-100/60 rounded-lg border border-amber-200 text-sm text-gray-800 leading-relaxed">
                  {w.one_line}
                </div>
              )}
              {/* 핵심 내용 */}
              {coreContent && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-700 mb-2">핵심 내용</h3>
                  <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap bg-gray-50 rounded p-3">{coreContent}</div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* BRM 분류체계 */}
      {d.brm_category && (() => {
        let brm: any = {};
        try { brm = typeof d.brm_category === 'string' ? JSON.parse(d.brm_category) : (d.brm_category || {}); } catch {}
        if (!brm.level1) return null;
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <h2 className="font-semibold text-sm text-gray-700 mb-2">BRM 정책분류체계</h2>
            <div className="flex items-center gap-2 text-sm">
              {[brm.level1, brm.level2, brm.level3, brm.level4].filter(Boolean).map((level: string, i: number) => (
                <span key={i} className="flex items-center gap-2">
                  {i > 0 && <span className="text-gray-300">›</span>}
                  <span className={`px-2 py-1 rounded ${i === 0 ? 'bg-primary-100 text-primary-700 font-medium' : 'bg-gray-100 text-gray-600'}`}>{level}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 키워드 */}
      {d.keywords && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="font-semibold text-sm text-gray-700 mb-2">키워드</h2>
          <div className="flex flex-wrap gap-1.5">
            {d.keywords.split(',').map((kw: string, i: number) => kw.trim() && (
              <span key={i} className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded-full border">{kw.trim()}</span>
            ))}
          </div>
        </div>
      )}

      {/* 결재라인 */}
      {approvalChain.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">결재라인</h2>
          <div className="px-4 py-3 flex flex-wrap gap-3">
            {approvalChain.map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-gray-300">→</span>}
                <div className="text-center px-3 py-2 bg-gray-50 rounded-lg border">
                  <p className="text-xs text-gray-500">{a.role}</p>
                  <p className="text-sm font-semibold text-gray-900">{a.name}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 연락처 */}
      {Object.keys(contactInfo).length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">연락처</h2>
          <table className="w-full text-sm">
            <tbody>
              {contactInfo.zip && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">우편번호</td><td className="px-4 py-2.5">{contactInfo.zip}</td></tr>}
              {contactInfo.address && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">주소</td><td className="px-4 py-2.5">{contactInfo.address}</td></tr>}
              {contactInfo.phone && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">전화</td><td className="px-4 py-2.5">{contactInfo.phone}</td></tr>}
              {contactInfo.fax && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">팩스</td><td className="px-4 py-2.5">{contactInfo.fax}</td></tr>}
              {contactInfo.email && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">이메일</td><td className="px-4 py-2.5"><a href={`mailto:${contactInfo.email}`} className="text-primary-600 hover:underline">{contactInfo.email}</a></td></tr>}
              {contactInfo.url && <tr className="border-b"><td className="px-4 py-2.5 font-medium text-gray-600 bg-gray-50 w-36">홈페이지</td><td className="px-4 py-2.5"><a href={contactInfo.url} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">{contactInfo.url}</a></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* 본문 요약은 위 '문서 내용 요약' 섹션에 통합됨 */}

      {/* 파일 목록 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <h2 className="px-4 py-3 bg-gray-50 font-semibold text-sm text-gray-700 border-b">
          파일 목록 ({d.files?.length || 0}개)
        </h2>
        {(!d.files || d.files.length === 0) ? (
          <p className="px-4 py-6 text-sm text-gray-500 text-center">첨부 파일이 없습니다.</p>
        ) : (
          <div className="divide-y">
            {d.files.map((f: any) => {
              let props: any = {};
              try { props = typeof f.file_properties === 'string' ? JSON.parse(f.file_properties) : (f.file_properties || {}); } catch {}
              let archiveEntries: any[] = [];
              try { archiveEntries = typeof f.archive_entries === 'string' ? JSON.parse(f.archive_entries) : (f.archive_entries || []); } catch {}
              const fileEntries = archiveEntries.filter((e: any) => !e.path?.endsWith('/'));

              return (
                <div key={f.id} className="px-4 py-4">
                  {/* File header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-white px-2 py-0.5 bg-primary-600 rounded">{f.file_se_dc || "기타"}</span>
                      {f.file_ext && <span className="text-xs font-mono text-gray-600 px-1.5 py-0.5 bg-gray-100 rounded border">{f.file_ext}</span>}
                      <span className="text-sm font-medium text-gray-900">{f.file_nm}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {f.download_url ? (
                        <a href={f.download_url} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1 rounded bg-primary-600 text-white hover:bg-primary-700">다운로드</a>
                      ) : f.downloaded ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">수집됨</span>
                      ) : null}
                      <span className={`text-xs px-2 py-0.5 rounded ${f.file_opp_yn === "Y" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {f.file_opp_yn === "Y" ? "공개" : "비공개"}
                      </span>
                    </div>
                  </div>

                  {/* File attributes */}
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
                        {f.content_length && <tr><td className="py-1 text-gray-500">추출 텍스트</td><td className="py-1">{f.content_length.toLocaleString()}자</td></tr>}
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
                        {fileEntries.length > 20 && <div className="text-purple-500 mt-1">... 외 {fileEntries.length - 20}개</div>}
                      </div>
                    </div>
                  )}

                  {/* File content summary */}
                  {f.summary && (
                    <div className="mt-2 ml-2 p-3 bg-amber-50 rounded text-xs border border-amber-100">
                      <p className="font-semibold text-amber-700 mb-1">파일 내용 요약</p>
                      <div className="text-gray-700 leading-relaxed whitespace-pre-wrap">{f.summary}</div>
                    </div>
                  )}

                  {/* Full content */}
                  {f.content && (
                    <details className="mt-2 ml-2">
                      <summary className="text-xs text-primary-600 cursor-pointer hover:underline">
                        전체 내용 보기 ({(f.content_length || f.content.length).toLocaleString()}자)
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
