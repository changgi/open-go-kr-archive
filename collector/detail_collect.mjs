#!/usr/bin/env node
/**
 * DB에 있는 meta_only 문서의 상세+파일+AI 수집
 * 쿠키+fetch로 병렬 실행 (Chrome 불필요)
 *
 * 사용법:
 *   node detail_collect.mjs [옵션]
 *   -w, --workers     병렬 수 (기본: .env PARALLEL_WORKERS 또는 16)
 *   -n, --max-count   최대 수집 건수
 *   -o, --output-dir  출력 디렉토리
 *   --skip-ai         Claude 분석 건너뜀
 *   --skip-files      파일 다운로드 건너뜀
 */

import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// .env
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').replace(/\r/g, '').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0 && !line.startsWith('#')) {
      const k = line.slice(0, idx).trim(), v = line.slice(idx + 1).trim();
      if (k && v && !process.env[k]) process.env[k] = v;
    }
  });
} catch {}

let Anthropic;
try { Anthropic = (await import('@anthropic-ai/sdk')).default; } catch {}
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const claude = anthropicKey && Anthropic ? new Anthropic({ apiKey: anthropicKey }) : null;

const CLI_PATH = path.join(__dirname, 'cheliped-browser', 'scripts', 'cheliped-cli.mjs');
const CWD = path.join(__dirname, 'cheliped-browser', 'scripts');
const BASE = 'https://www.open.go.kr';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY) || 500;
const pdfParse = require('pdf-parse');

function now() { return Date.now(); }
function elapsed(s) { const ms=Date.now()-s; return ms<60000?`${(ms/1000).toFixed(1)}s`:`${Math.floor(ms/60000)}m${Math.floor((ms%60000)/1000)}s`; }
function ts() { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function sanitize(n,l=40){return n.replace(/[\\/:"*?<>|\[\]「」\r\n&;]/g,'_').slice(0,l).trim()||'untitled';}
function formatBytes(b){if(!b)return'0B';const u=['B','KB','MB','GB'];let i=0,s=b;while(s>=1024&&i<u.length-1){s/=1024;i++;}return`${s.toFixed(1)}${u[i]}`;}
function getFileExt(n){if(!n)return'';const d=n.lastIndexOf('.');return d>=0?n.slice(d).toLowerCase():'';}
const OPP={'1':'공개','2':'부분공개','3':'비공개','5':'열람제한'};
function canDownload(o,f,u,d){const t=new Date().toISOString().slice(0,10).replace(/-/g,'');if(u==='N')return[false,'국장급'];if(o==='3')return[false,'비공개'];if(o==='5'&&(d||'')>t)return[false,'열람제한'];if(o==='1')return[true,''];if(o==='2'&&f==='Y')return[true,''];return[false,'부분공개'];}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function hdrs(cookies) {
  return {'Cookie':cookies,'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','Referer':`${BASE}/othicInfo/infoList/orginlInfoList.do`};
}

// Claude 분석
async function analyzeDoc(text, meta) {
  if (!claude || !text || text.length < 20) return null;
  try {
    const r = await claude.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1500,
      messages: [{ role: 'user', content: `공문서를 분석하여 JSON만 출력하세요.

문서: ${meta.info_sj||''}
기관: ${meta.proc_instt_nm||''} ${meta.chrg_dept_nm||''}
본문:
${text.slice(0,3000)}

JSON:
{"sender":{"org":"","dept":"","person":"","role":""},"receiver":{"org":"","dept":"","person":"","role":""},"doc_type":"내부결재/외부발송","summary_6w":{"who":"","to_whom":"내부결재시 결재권자 전원 직위+이름","when":"","where":"","what":"구체적 2~3문장","why":"1~2문장"},"one_line_summary":"자연스러운 한 문장","purpose":"","action_required":"","brm":{"level1":"","level2":"","level3":"","level4":""},"approval_chain":[{"role":"","name":""}],"contact":{"zip":"","address":"숫자-기관명 사이 공백","phone":"","fax":"","email":"","url":""}}` }],
    });
    const m = r.content[0]?.text?.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch(e) { /* skip */ }
  return null;
}

// Args
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    workers: parseInt(process.env.PARALLEL_WORKERS) || 16,
    maxCount: Infinity, outputDir: './full_collection',
    skipAi: false, skipFiles: false,
  };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='-w'||a==='--workers')opts.workers=parseInt(args[++i])||16;
    else if(a==='-n'||a==='--max-count')opts.maxCount=parseInt(args[++i])||Infinity;
    else if(a==='-o'||a==='--output-dir')opts.outputDir=args[++i];
    else if(a==='--skip-ai')opts.skipAi=true;
    else if(a==='--skip-files')opts.skipFiles=true;
  }
  return opts;
}

// 쿠키 추출
function extractCookies() {
  log('[쿠키] 추출 중...');
  try {
    const r = execFileSync('node', [CLI_PATH, JSON.stringify([
      {cmd:'goto',args:[`${BASE}/othicInfo/infoList/orginlInfoList.do`]},
      {cmd:'run-js',args:['document.cookie']},{cmd:'close'},
    ])], {encoding:'utf8',timeout:120000,cwd:CWD});
    const c = JSON.parse(r)[1]?.result?.result;
    if(c){log(`[쿠키] 성공`);return c;}
  }catch(e){if(e.stdout){try{const c=JSON.parse(e.stdout)[1]?.result?.result;if(c)return c;}catch{}}}
  log('[쿠키] 실패');return null;
}

// DB에서 meta_only 문서 로드
async function loadMetaOnly(maxCount) {
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  while (all.length < maxCount) {
    const r = await fetch(`${supabaseUrl}/rest/v1/documents?status=eq.meta_only&select=prdctn_instt_regist_no,prdctn_dt_raw,instt_se_cd,info_sj,proc_instt_nm,chrg_dept_nm,charger_nm,doc_no,unit_job_nm,opp_se_cd,nst_cl_nm,instt_cd,keywords,full_dept_nm&order=collected_at.asc&limit=${pageSize}&offset=${offset}`, {
      headers: {'apikey':supabaseKey,'Authorization':`Bearer ${supabaseKey}`},
    });
    const rows = await r.json();
    if (!rows.length) break;
    all.push(...rows);
    log(`  [DB] ${all.length.toLocaleString()}건 로드...`);
    offset += pageSize;
    if (rows.length < pageSize) break;
  }
  return all.slice(0, maxCount);
}

// 워커
async function worker(id, docs, cookies, opts, stats) {
  for (const doc of docs) {
    const t = now();
    const regNo = doc.prdctn_instt_regist_no;
    const nstSeCd = regNo.slice(0,3);
    const prdnDt = doc.prdctn_dt_raw || '';

    try {
      // 상세 페이지
      const detailUrl = `${BASE}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`;
      const res = await fetch(detailUrl, {headers:hdrs(cookies)});
      const html = await res.text();

      // VO 추출
      let vo = null;
      const idx = html.indexOf('var result');
      if (idx > 0) {
        const start = html.indexOf('{', idx);
        let depth=0, end=start;
        for(let j=start;j<html.length&&j<start+300000;j++){if(html[j]==='{')depth++;if(html[j]==='}')depth--;if(depth===0){end=j+1;break;}}
        try { vo = JSON.parse(html.substring(start, end)).openCateSearchVO; } catch{}
      }

      // DOM 메타
      let fullNstClNm = doc.nst_cl_nm||'', prsrvPdCd = '', detailDeptNm = doc.chrg_dept_nm||'', detailDocNo = doc.doc_no||'';
      const ths = html.match(/<th[^>]*>(.*?)<\/th>/gs)||[];
      const tds = html.match(/<td[^>]*>(.*?)<\/td>/gs)||[];
      ths.forEach((th,i) => {
        const k = th.replace(/<[^>]+>/g,'').trim();
        const v = (tds[i]||'').replace(/<[^>]+>/g,'').trim();
        if(k==='분류체계'&&v) fullNstClNm=v;
        if(k==='보존기간'&&v) prsrvPdCd=v;
        if(k==='담당부서명'&&v&&!detailDeptNm) detailDeptNm=v;
        if(k==='문서번호'&&v&&!detailDocNo) detailDocNo=v;
      });
      if(vo){
        if(vo.nstClNm) fullNstClNm=vo.nstClNm;
        if(vo.prsrvPdCd) prsrvPdCd=vo.prsrvPdCd;
        if(vo.chrgDeptNm) detailDeptNm=vo.chrgDeptNm;
        if(vo.docNo) detailDocNo=vo.docNo;
      }

      // 파일 다운로드
      let downloadCount = 0;
      const fileList = vo?.fileList || [];
      const pDate = (prdnDt||'').slice(0,8);
      const folderPath = path.join(opts.outputDir, `${stats.total+1}_${sanitize(doc.info_sj||'')}`);
      fs.mkdirSync(folderPath, {recursive:true});

      let bodyText = '';
      if (!opts.skipFiles && fileList.length > 0) {
        for (const f of fileList) {
          const [dlOk] = canDownload(vo?.oppSeCd, f.fileOppYn, vo?.urtxtYn, vo?.dtaRedgLmttEndYmd);
          if (!dlOk) continue;
          try {
            const isPdf = f.fileNm?.toLowerCase().endsWith('.pdf')?'Y':'N';
            const r1 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileRequest.ajax`, {
              method:'POST',headers:{...hdrs(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`fileId=${f.fileId}&esbFileName=${encodeURIComponent(f.fileNm)}&docId=${encodeURIComponent(vo.docNo||'')}&ctDate=${vo.prdnDt}&orgCd=${vo.nstCd}&prdnNstRgstNo=${regNo}&oppSeCd=${vo.oppSeCd}&isPdf=${isPdf}&chrgDeptNm=${encodeURIComponent(vo.chrgDeptNm||'')}`,
            });
            const s1 = await r1.json();
            if(!s1.esbFilePath)continue;
            const r2 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileFilter.ajax`, {
              method:'POST',headers:{...hdrs(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`prdnNstRgstNo=${regNo}&prdnDt=${vo.prdnDt}&esbFilePath=${encodeURIComponent(s1.esbFilePath)}&esbFileName=${encodeURIComponent(s1.esbFileName)}&fileName=${encodeURIComponent(s1.fileName)}&fileId=${f.fileId}&orglPrdnNstCd=${s1.orglPrdnNstCd||''}&nstCd=${vo.nstCd}&orgCd=${vo.nstCd}&orgSeCd=${nstSeCd}&isPdf=${isPdf}&step=step2&closegvrnYn=${s1.orginlFileVO?.closegvrnYn||'N'}&ndnfFiltrRndabtYn=N`,
            });
            const s2 = await r2.json();
            if(!s2.esbFilePath)continue;
            const r3 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileDownload.down`, {
              method:'POST',headers:{...hdrs(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`esbFilePath=${encodeURIComponent(s2.esbFilePath)}&esbFileName=${encodeURIComponent(s2.esbFileName)}&fileName=${encodeURIComponent(s2.fileName)}&isPdf=${s2.isPdf||isPdf}&prdnNstRgstNo=${regNo}&prdnDt=${vo.prdnDt}&fileId=${f.fileId}&gubun=${encodeURIComponent(s2.esbFilePath)}`,
            });
            const buf = Buffer.from(await r3.arrayBuffer());
            if(buf.length>0){
              const fname = sanitize(`${f.fileSeDc||'기타'}_${f.fileNm}`,200);
              fs.writeFileSync(path.join(folderPath, fname), buf);
              downloadCount++;
              if(getFileExt(f.fileNm)==='.pdf'){
                try{const pd=await pdfParse(buf);if(pd.text){bodyText=pd.text;fs.writeFileSync(path.join(folderPath,fname+'_내용.md'),`# ${f.fileNm}\n\n${pd.text}`,'utf8');}}catch{}
              }
            }
          }catch{}
          await sleep(REQUEST_DELAY);
        }
      }

      // AI 분석
      let aiResult = null;
      if (!opts.skipAi && bodyText && claude) {
        aiResult = await analyzeDoc(bodyText, doc);
      }

      // metadata.md
      const oppLabel = OPP[doc.opp_se_cd]||doc.opp_se_cd;
      const fmtDate = pDate?.length>=8?`${pDate.slice(0,4)}.${pDate.slice(4,6)}.${pDate.slice(6,8)}`:'-';
      let md = `# ${doc.info_sj}\n\n## 메타데이터\n\n| 항목 | 내용 |\n|------|------|\n`;
      md += `| 제목 | ${doc.info_sj} |\n| 문서번호 | ${detailDocNo} |\n| 기관명 | ${doc.proc_instt_nm} |\n`;
      md += `| 담당부서 | ${detailDeptNm} |\n| 담당자 | ${doc.charger_nm} |\n| 생산일자 | ${fmtDate} |\n`;
      md += `| 보존기간 | ${prsrvPdCd} |\n| 단위업무 | ${doc.unit_job_nm} |\n| 공개여부 | ${oppLabel} |\n`;
      md += `| 분류체계 | ${fullNstClNm} |\n| 원문등록번호 | ${regNo} |\n`;
      if(doc.keywords) md += `| 키워드 | ${doc.keywords} |\n`;
      md += `\n## 파일 목록 (${fileList.length}개)\n\n`;
      for(const f of fileList){
        const [ok]=canDownload(vo?.oppSeCd,f.fileOppYn,vo?.urtxtYn,vo?.dtaRedgLmttEndYmd);
        md+=`- **${f.fileSeDc||'기타'}**: ${f.fileNm} (${formatBytes(Number(f.fileByteNum))}) [${ok?'공개':'비공개'}]\n`;
      }
      md += `\n## 원문 링크\n\n${detailUrl}\n`;
      fs.writeFileSync(path.join(folderPath,'metadata.md'), md, 'utf8');

      // DB 업데이트
      const update = {
        doc_no: detailDocNo, chrg_dept_nm: detailDeptNm,
        nst_cl_nm: fullNstClNm, prsrv_pd_cd: prsrvPdCd||null,
        file_count: fileList.length, downloaded_count: downloadCount,
        original_url: detailUrl, status: 'ok',
      };
      if (aiResult) {
        Object.assign(update, {
          sender_info: aiResult.sender ? JSON.stringify(aiResult.sender) : null,
          receiver_info: aiResult.receiver ? JSON.stringify(aiResult.receiver) : null,
          ai_summary: aiResult.summary_6w ? JSON.stringify(aiResult.summary_6w) : null,
          six_w_analysis: aiResult.summary_6w ? JSON.stringify(aiResult.summary_6w) : null,
          one_line_summary: aiResult.one_line_summary || null,
          core_content: [aiResult.purpose, aiResult.action_required, aiResult.summary_6w?.what].filter(Boolean).join('\n\n') || null,
          brm_category: aiResult.brm ? JSON.stringify(aiResult.brm) : null,
          doc_type: aiResult.doc_type || null,
          recipient: aiResult.doc_type==='내부결재' ? `${aiResult.receiver?.role||''} ${aiResult.receiver?.person||''}`.trim() : aiResult.receiver?.org || null,
          approval_chain: aiResult.approval_chain?.length > 0 ? JSON.stringify(aiResult.approval_chain) : null,
          contact_info: aiResult.contact ? JSON.stringify(aiResult.contact) : null,
        });
      }

      await fetch(`${supabaseUrl}/rest/v1/documents?prdctn_instt_regist_no=eq.${regNo}`, {
        method:'PATCH', headers:{'apikey':supabaseKey,'Authorization':`Bearer ${supabaseKey}`,'Content-Type':'application/json','Prefer':'return=minimal'},
        body:JSON.stringify(update),
      });

      stats.total++;
      if(stats.total%50===0){
        const spd=(stats.total/((now()-stats.start)/1000)).toFixed(1);
        log(`  [W${id}] ${stats.total.toLocaleString()}건 | ${spd}건/초 | AI:${aiResult?'✓':'✗'} | 파일:${downloadCount} | ${elapsed(stats.start)}`);
      }
    } catch(e) {
      stats.errors++;
    }
    await sleep(REQUEST_DELAY);
  }
}

async function main() {
  const opts = parseArgs();
  const totalStart = now();
  log(`[상세 수집] 워커=${opts.workers} | AI=${!opts.skipAi&&claude?'ON':'OFF'} | 파일=${!opts.skipFiles?'ON':'OFF'}`);

  fs.mkdirSync(opts.outputDir, {recursive:true});

  // 쿠키
  const cookies = extractCookies();
  if(!cookies){log('[실패] 쿠키 추출 불가');return;}

  // DB에서 meta_only 문서 로드
  const limit = opts.maxCount === Infinity ? 100000 : opts.maxCount;
  log(`[DB] meta_only 문서 로딩 (최대 ${limit.toLocaleString()}건)...`);
  const docs = await loadMetaOnly(limit);
  log(`[DB] ${docs.length.toLocaleString()}건 로드`);
  if(!docs.length){log('[완료] 처리할 문서 없음');return;}

  // 병렬 분배
  const chunkSize = Math.ceil(docs.length / opts.workers);
  const stats = {total:0, errors:0, start:now()};
  const workers = [];

  for(let w=0;w<opts.workers;w++){
    const chunk = docs.slice(w*chunkSize, (w+1)*chunkSize);
    if(!chunk.length) continue;
    log(`  [W${w}] ${chunk.length}건`);
    workers.push(worker(w, chunk, cookies, opts, stats));
  }

  await Promise.all(workers);
  log(`\n[완료] ${stats.total.toLocaleString()}건 | 에러 ${stats.errors} | ${(stats.total/((now()-totalStart)/1000)).toFixed(1)}건/초 | ${elapsed(totalStart)}`);
}

main().catch(e=>{console.error(e);process.exit(1);});
