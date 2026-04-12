#!/usr/bin/env node
/**
 * open.go.kr 원문정보 병렬 수집기
 *
 * 1단계: 브라우저로 쿠키 추출 + 목록 전체 수집 (브라우저 세션)
 * 2단계: 쿠키+fetch로 상세+파일 병렬 수집 (Chrome 불필요)
 *
 * 사용법:
 *   node parallel_collect.mjs [옵션]
 *   -s, --start-date   시작일 YYYYMMDD
 *   -e, --end-date     종료일 YYYYMMDD
 *   -n, --max-count    최대 수집 건수 (기본: 전체)
 *   -k, --keyword      검색어
 *   -o, --output-dir   출력 디렉토리
 *   -w, --workers      병렬 수 (기본: .env PARALLEL_WORKERS 또는 4)
 *   --meta-only        메타데이터만 수집 (상세/파일 건너뜀)
 *   --skip-files       파일 다운로드 건너뜀
 *   --skip-ai          Claude 분석 건너뜀
 */

import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, upsertDocuments, getCollectedSet, getStats, closeDB } from './local_db.mjs';

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

function now() { return Date.now(); }
function elapsed(s) { const ms=Date.now()-s; return ms<60000?`${(ms/1000).toFixed(1)}s`:`${Math.floor(ms/60000)}m${Math.floor((ms%60000)/1000)}s`; }
function ts() { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function fmt(d) { return d.toISOString().slice(0,10).replace(/-/g,''); }
function htmlDecode(s) { return (s||'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'"); }
function sanitize(n,l=40){return n.replace(/[\\/:"*?<>|\[\]「」\r\n&;]/g,'_').slice(0,l).trim()||'untitled';}
// 샤드 경로: 100개 단위로 분할 (샤드당 <1,000 보장)
function shardFolder(outputDir, num, title) {
  const shard = Math.floor(num / 100).toString().padStart(4, '0');
  return path.join(outputDir, shard, `${num}_${sanitize(title)}`);
}
function formatBytes(b){if(!b)return'0B';const u=['B','KB','MB','GB'];let i=0,s=b;while(s>=1024&&i<u.length-1){s/=1024;i++;}return`${s.toFixed(1)}${u[i]}`;}
function getFileExt(n){if(!n)return'';const d=n.lastIndexOf('.');return d>=0?n.slice(d).toLowerCase():'';}
const OPP={'1':'공개','2':'부분공개','3':'비공개','5':'열람제한'};
function canDownload(o,f,u,d){const t=fmt(new Date());if(u==='N')return[false];if(o==='3')return[false];if(o==='5'&&(d||'')>t)return[false];if(o==='1')return[true];if(o==='2'&&f==='Y')return[true];return[false];}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Args
function parseArgs() {
  const args = process.argv.slice(2);
  const today = new Date();
  const ago = new Date(today); ago.setFullYear(today.getFullYear() - 5);
  const opts = {
    keyword:'', startDate:fmt(ago), endDate:fmt(today),
    maxCount:Infinity, outputDir:'./open_go_kr_docs', oppSeCd:'',
    workers: parseInt(process.env.PARALLEL_WORKERS) || 4,
    metaOnly: false, skipFiles: false, skipAi: false,
  };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='-k'||a==='--keyword')opts.keyword=args[++i]||'';
    else if(a==='-s'||a==='--start-date')opts.startDate=(args[++i]||'').replace(/-/g,'');
    else if(a==='-e'||a==='--end-date')opts.endDate=(args[++i]||'').replace(/-/g,'');
    else if(a==='-n'||a==='--max-count')opts.maxCount=parseInt(args[++i])||Infinity;
    else if(a==='-o'||a==='--output-dir')opts.outputDir=args[++i];
    else if(a==='-w'||a==='--workers')opts.workers=parseInt(args[++i])||4;
    else if(a==='--opp-se-cd')opts.oppSeCd=args[++i];
    else if(a==='--meta-only')opts.metaOnly=true;
    else if(a==='--skip-files')opts.skipFiles=true;
    else if(a==='--skip-ai')opts.skipAi=true;
  }
  return opts;
}

// ── 쿠키 추출 ──
function extractCookies() {
  log('[쿠키] 브라우저로 세션 쿠키 추출...');
  try {
    // --session 없이 직접 실행 (세션 옵션이 타임아웃 유발)
    const r = execFileSync('node', [CLI_PATH, JSON.stringify([
      {cmd:'goto',args:[`${BASE}/othicInfo/infoList/orginlInfoList.do`]},
      {cmd:'run-js',args:['document.cookie']},
      {cmd:'close'},
    ])], {encoding:'utf8',timeout:120000,cwd:CWD});
    const p = JSON.parse(r);
    const cookies = p[1]?.result?.result;
    if(cookies){log(`[쿠키] 성공: ${cookies.slice(0,60)}...`);return cookies;}
  }catch(e){
    // stdout에서 추출 시도
    if(e.stdout){
      try{
        const p=JSON.parse(e.stdout);
        const c=p[1]?.result?.result;
        if(c){log(`[쿠키] 성공(stderr): ${c.slice(0,60)}...`);return c;}
      }catch{}
    }
    log(`[쿠키] 실패: ${e.message?.slice(0,80)}`);
  }
  return null;
}

// ── fetch 헬퍼 ──
function headers(cookies) {
  return {
    'Cookie': cookies,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Referer': `${BASE}/othicInfo/infoList/orginlInfoList.do`,
  };
}

// ── 기수집 로드 ──
async function loadCollected(outputDir) {
  // SQLite에서 즉시 로드 (네트워크 없음)
  return getCollectedSet();
}

// ── 1단계: 브라우저로 목록 수집 ──
async function collectMetaList(cookies, opts, already) {
  log('[1단계] 브라우저로 목록 수집...');
  const docs = [];
  let page = 1, rtnTotal = 0, retries = 0;

  // 상태 복원
  const stPath = path.join(opts.outputDir, '.parallel_state.json');
  try { const st = JSON.parse(fs.readFileSync(stPath,'utf8')); page=st.nextPage||1; docs.push(...(st.docs||[])); log(`[재개] 페이지 ${page}부터, 기존 ${docs.length}건`); } catch{}

  while (docs.length < opts.maxCount) {
    // 배치: 한 번의 cheliped run-js에서 20페이지 연속 조회
    const batchSize = 20;
    const batchEndPage = Math.min(page + batchSize - 1, page + 10000);
    const batchJs = `
var allItems=[];var total=0;var code="";
for(var p=${page};p<=${batchEndPage};p++){
  var x=new XMLHttpRequest();x.open("POST","/othicInfo/infoList/orginlInfoList.ajax",false);
  x.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
  x.setRequestHeader("X-Requested-With","XMLHttpRequest");
  x.send("kwd=${encodeURIComponent(opts.keyword)}&startDate=${opts.startDate}&endDate=${opts.endDate}&insttCd=&insttSeCd=&othbcSeCd=${opts.oppSeCd}&viewPage="+p+"&rowPage=50&sort=d");
  var j=JSON.parse(x.responseText);
  code=j.result&&j.result.code;if(code!=="200")break;
  total=j.result.rtnTotal;
  var list=j.result.rtnList||[];
  for(var i=0;i<list.length;i++)allItems.push(list[i]);
  if(list.length<50)break;
}
JSON.stringify({code:code,total:total,count:allItems.length,endPage:p,list:allItems});
    `.replace(/\n/g,' ');

    let results;
    try {
      const r = execFileSync('node', [CLI_PATH, JSON.stringify([
        {cmd:'goto',args:[`${BASE}/othicInfo/infoList/orginlInfoList.do`]},
        {cmd:'run-js',args:[batchJs]},
      ])], {encoding:'utf8',timeout:180000,maxBuffer:100*1024*1024,cwd:CWD});
      results = JSON.parse(r);
    } catch(e) {
      if(e.stdout) try{results=JSON.parse(e.stdout);}catch{}
      if(!results){
        retries++;
        if(retries>=5){
          // 상태 저장 후 중단 (재실행 시 이어서)
          fs.writeFileSync(stPath, JSON.stringify({nextPage:page,docsCount:docs.length}), 'utf8');
          log(`[중단] 5회 연속 실패. 재실행하면 페이지 ${page}부터 재개됩니다.`);
          break;
        }
        log(`  [재시도] ${retries}/5`);
        await sleep(3000);
        continue;
      }
    }
    retries = 0;

    let listData = null;
    const val = results?.[1]?.result?.result;
    if(typeof val==='string')try{listData=JSON.parse(val);}catch{}

    if(!listData||listData.code!=='200'){
      log(`  [경고] 페이지 ${page} 코드: ${listData?.code}, 재시도...`);
      await sleep(2000);
      continue;
    }

    rtnTotal = listData.total || rtnTotal;
    const items = listData.list || [];
    if(page===1)log(`[목록] 전체 ${rtnTotal.toLocaleString()}건`);
    if(!items.length){log('[목록] 완료');break;}

    let newCount = 0;
    for(const doc of items){
      const regNo = doc.PRDCTN_INSTT_REGIST_NO;
      if(!regNo||already.has(regNo))continue;
      already.add(regNo);
      newCount++;
      docs.push({
        regNo, prdnDt: doc.PRDCTN_DT||'', nstSeCd: doc.INSTT_SE_CD||'',
        title: htmlDecode(doc.INFO_SJ||''), insttNm: htmlDecode(doc.PROC_INSTT_NM||''),
        deptNm: htmlDecode(doc.CHRG_DEPT_NM||''), chargerNm: htmlDecode(doc.CHARGER_NM||''),
        docNo: htmlDecode(doc.DOC_NO||''), unitJob: htmlDecode(doc.UNIT_JOB_NM||''),
        oppSeCd: doc.OTHBC_SE_CD||'', nstClNm: htmlDecode(doc.RQEST_TY_THEMA_NM||''),
        insttCd: doc.INSTT_CD||'', fileNm: htmlDecode(doc.FILE_NM||''),
        keywords: (doc.tma_kwd||'').replace(/\n/g,', ').trim(),
        fullDeptNm: htmlDecode(doc.NFLST_CHRG_DEPT_NM||''),
        pDate: doc.P_DATE || (doc.PRDCTN_DT||'').slice(0,8),
      });
      if(docs.length>=opts.maxCount)break;
    }

    const endPage = listData.endPage || page + batchSize;
    log(`  페이지 ${page}~${endPage}: +${newCount} (배치 ${items.length}건) | 누적 ${docs.length.toLocaleString()}/${rtnTotal.toLocaleString()}`);

    // 즉시 CSV 저장 (매 배치)
    const csvPath = path.join(opts.outputDir, 'collection_log.csv');
    const newDocs = docs.slice(-newCount);
    for (const d of newDocs) {
      fs.appendFileSync(csvPath,
        `${docs.length},"${d.regNo}","${d.title.replace(/"/g,'""')}","${d.insttNm}",${d.pDate},"${OPP[d.oppSeCd]||d.oppSeCd}"\n`, 'utf8');
    }

    // SQLite 배치 저장 (즉시, 네트워크 없음)
    if (newDocs.length > 0) {
      const dbBatch = newDocs.map(d => ({
        prdctn_instt_regist_no: d.regNo, info_sj: d.title, doc_no: d.docNo,
        proc_instt_nm: d.insttNm, chrg_dept_nm: d.deptNm, charger_nm: d.chargerNm,
        prdctn_dt: d.pDate?.length>=8 ? `${d.pDate.slice(0,4)}-${d.pDate.slice(4,6)}-${d.pDate.slice(6,8)}` : null,
        prdctn_dt_raw: d.prdnDt, unit_job_nm: d.unitJob,
        opp_se_cd: d.oppSeCd, opp_se_nm: OPP[d.oppSeCd]||d.oppSeCd,
        nst_cl_nm: d.nstClNm, instt_cd: d.insttCd, instt_se_cd: d.nstSeCd,
        keywords: d.keywords||null, full_dept_nm: d.fullDeptNm||null,
        status: 'meta_only',
      }));
      try { upsertDocuments(dbBatch); } catch {}
    }

    // 상태 저장
    fs.writeFileSync(stPath, JSON.stringify({nextPage:endPage+1,docsCount:docs.length}), 'utf8');

    // totalPages 기준으로 종료 (기수집 skip해도 계속 진행)
    const totalPages = Math.ceil(rtnTotal / 50);
    if (endPage >= totalPages) { log('[목록] 마지막 페이지 도달'); break; }
    if (items.length === 0) { log('[목록] 빈 응답'); break; }
    page = endPage + 1;
  }

  try{fs.unlinkSync(path.join(opts.outputDir,'.parallel_state.json'));}catch{}
  log(`[1단계 완료] ${docs.length.toLocaleString()}건 수집`);
  return docs;
}

// ── 2단계: 쿠키+fetch로 상세 수집 (워커) ──
async function detailWorker(workerId, docs, cookies, opts, csvPath, stats) {
  const pdfParse = require('pdf-parse');

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const t = now();

    try {
      // 상세 페이지 fetch
      const nstSeCd = doc.regNo.slice(0,3) || doc.nstSeCd;
      const detailUrl = `${BASE}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${doc.regNo}&prdnDt=${doc.prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`;
      const res = await fetch(detailUrl, { headers: headers(cookies) });
      const html = await res.text();

      // var result 파싱
      let vo = null;
      const idx = html.indexOf('var result');
      if (idx > 0) {
        const start = html.indexOf('{', idx);
        let depth=0, end=start;
        for(let j=start;j<html.length&&j<start+300000;j++){if(html[j]==='{')depth++;if(html[j]==='}')depth--;if(depth===0){end=j+1;break;}}
        try {
          const obj = JSON.parse(html.substring(start, end));
          vo = obj.openCateSearchVO;
        } catch {}
      }

      // DOM 메타 추출 (th/td)
      let fullNstClNm = doc.nstClNm, prsrvPdCd = '', detailDeptNm = doc.deptNm, detailDocNo = doc.docNo;
      const thMatches = html.match(/<th[^>]*>(.*?)<\/th>/gs) || [];
      const tdMatches = html.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
      const dom = {};
      thMatches.forEach((th, idx) => {
        const key = th.replace(/<[^>]+>/g, '').trim();
        const val = (tdMatches[idx] || '').replace(/<[^>]+>/g, '').trim();
        if (key) dom[key] = val;
      });
      if (dom['분류체계']) fullNstClNm = dom['분류체계'];
      if (dom['보존기간']) prsrvPdCd = dom['보존기간'];
      if (dom['담당부서명'] && !detailDeptNm) detailDeptNm = dom['담당부서명'];
      if (dom['문서번호'] && !detailDocNo) detailDocNo = dom['문서번호'];

      // VO에서도 추출 (더 정확할 수 있음)
      if (vo) {
        if (vo.nstClNm) fullNstClNm = vo.nstClNm;
        if (vo.prsrvPdCd) prsrvPdCd = vo.prsrvPdCd;
        if (vo.chrgDeptNm) detailDeptNm = vo.chrgDeptNm;
        if (vo.docNo) detailDocNo = vo.docNo;
      }

      // 파일 다운로드
      let downloadCount = 0;
      const fileList = vo?.fileList || [];
      const folderPath = shardFolder(opts.outputDir, stats.total + 1, doc.title);

      if (!opts.metaOnly && fileList.length > 0 && !opts.skipFiles) {
        fs.mkdirSync(folderPath, { recursive: true });

        for (const f of fileList) {
          const [dlOk] = canDownload(vo?.oppSeCd, f.fileOppYn, vo?.urtxtYn, vo?.dtaRedgLmttEndYmd);
          if (!dlOk) continue;

          try {
            const isPdf = f.fileNm?.toLowerCase().endsWith('.pdf') ? 'Y' : 'N';
            // Step 1
            const r1 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileRequest.ajax`, {
              method:'POST', headers:{...headers(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`fileId=${f.fileId}&esbFileName=${encodeURIComponent(f.fileNm)}&docId=${encodeURIComponent(vo.docNo||'')}&ctDate=${vo.prdnDt}&orgCd=${vo.nstCd}&prdnNstRgstNo=${doc.regNo}&oppSeCd=${vo.oppSeCd}&isPdf=${isPdf}&chrgDeptNm=${encodeURIComponent(vo.chrgDeptNm||'')}`,
            });
            const s1 = await r1.json();
            if (!s1.esbFilePath) continue;

            // Step 2
            const r2 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileFilter.ajax`, {
              method:'POST', headers:{...headers(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`prdnNstRgstNo=${doc.regNo}&prdnDt=${vo.prdnDt}&esbFilePath=${encodeURIComponent(s1.esbFilePath)}&esbFileName=${encodeURIComponent(s1.esbFileName)}&fileName=${encodeURIComponent(s1.fileName)}&fileId=${f.fileId}&orglPrdnNstCd=${s1.orglPrdnNstCd||''}&nstCd=${vo.nstCd}&orgCd=${vo.nstCd}&orgSeCd=${nstSeCd}&isPdf=${isPdf}&step=step2&closegvrnYn=${s1.orginlFileVO?.closegvrnYn||'N'}&ndnfFiltrRndabtYn=N`,
            });
            const s2 = await r2.json();
            if (!s2.esbFilePath) continue;

            // Step 3
            const r3 = await fetch(`${BASE}/util/wonmunUtils/wonmunFileDownload.down`, {
              method:'POST', headers:{...headers(cookies),'Content-Type':'application/x-www-form-urlencoded'},
              body:`esbFilePath=${encodeURIComponent(s2.esbFilePath)}&esbFileName=${encodeURIComponent(s2.esbFileName)}&fileName=${encodeURIComponent(s2.fileName)}&isPdf=${s2.isPdf||isPdf}&prdnNstRgstNo=${doc.regNo}&prdnDt=${vo.prdnDt}&fileId=${f.fileId}&gubun=${encodeURIComponent(s2.esbFilePath)}`,
            });
            const buf = Buffer.from(await r3.arrayBuffer());
            if (buf.length > 0) {
              const fname = sanitize(`${f.fileSeDc||'기타'}_${f.fileNm}`, 200);
              fs.writeFileSync(path.join(folderPath, fname), buf);
              downloadCount++;

              // PDF 텍스트 추출
              if (getFileExt(f.fileNm) === '.pdf') {
                try {
                  const pd = await pdfParse(buf);
                  if (pd.text) {
                    fs.writeFileSync(path.join(folderPath, fname + '_내용.md'),
                      `# ${f.fileNm}\n\n${pd.text}`, 'utf8');
                  }
                } catch {}
              }
            }
          } catch {}
          await sleep(REQUEST_DELAY);
        }
      }

      // metadata.md 생성
      if (!opts.metaOnly) {
        fs.mkdirSync(folderPath, { recursive: true });
        const oppLabel = OPP[doc.oppSeCd] || doc.oppSeCd;
        const fmtDate = doc.pDate?.length>=8 ? `${doc.pDate.slice(0,4)}.${doc.pDate.slice(4,6)}.${doc.pDate.slice(6,8)}` : '-';
        let md = `# ${doc.title}\n\n## 메타데이터\n\n| 항목 | 내용 |\n|------|------|\n`;
        md += `| 제목 | ${doc.title} |\n| 문서번호 | ${detailDocNo} |\n| 기관명 | ${doc.insttNm} |\n`;
        md += `| 담당부서 | ${detailDeptNm} |\n| 담당자 | ${doc.chargerNm} |\n| 생산일자 | ${fmtDate} |\n`;
        md += `| 보존기간 | ${prsrvPdCd} |\n| 단위업무 | ${doc.unitJob} |\n| 공개여부 | ${oppLabel} |\n`;
        md += `| 분류체계 | ${fullNstClNm} |\n| 원문등록번호 | ${doc.regNo} |\n`;
        if (doc.keywords) md += `| 키워드 | ${doc.keywords} |\n`;
        md += `\n## 파일 목록 (${fileList.length}개)\n\n`;
        for (const f of fileList) {
          const [dlOk] = canDownload(vo?.oppSeCd, f.fileOppYn, vo?.urtxtYn, vo?.dtaRedgLmttEndYmd);
          md += `- **${f.fileSeDc||'기타'}**: ${f.fileNm} (${formatBytes(Number(f.fileByteNum))}) [${dlOk?'공개':'비공개'}]\n`;
        }
        md += `\n## 원문 링크\n\n${detailUrl}\n`;
        fs.writeFileSync(path.join(folderPath, 'metadata.md'), md, 'utf8');
      }

      // PDF 텍스트에서 추가 메타 추출
      let bodyText = '';
      const bodyContentFile = fs.readdirSync(folderPath || '.').find(f => f.endsWith('_내용.md'));
      if (bodyContentFile && folderPath) {
        try { bodyText = fs.readFileSync(path.join(folderPath, bodyContentFile), 'utf8').replace(/^#.*\n\n/, ''); } catch {}
      }

      // Supabase 저장
      if (supabaseUrl && supabaseKey) {
        const docData = {
          prdctn_instt_regist_no: doc.regNo, info_sj: doc.title, doc_no: detailDocNo,
          proc_instt_nm: doc.insttNm, chrg_dept_nm: detailDeptNm, charger_nm: doc.chargerNm,
          prdctn_dt: doc.pDate?.length>=8 ? `${doc.pDate.slice(0,4)}-${doc.pDate.slice(4,6)}-${doc.pDate.slice(6,8)}` : null,
          prdctn_dt_raw: doc.prdnDt, unit_job_nm: doc.unitJob,
          opp_se_cd: doc.oppSeCd, opp_se_nm: OPP[doc.oppSeCd]||doc.oppSeCd,
          nst_cl_nm: fullNstClNm, prsrv_pd_cd: prsrvPdCd||null,
          instt_cd: doc.insttCd, instt_se_cd: doc.nstSeCd,
          keywords: doc.keywords||null, full_dept_nm: doc.fullDeptNm||null,
          file_count: fileList.length, downloaded_count: downloadCount,
          original_url: detailUrl, status: opts.metaOnly ? 'meta_only' : 'ok',
        };
        try {
          await fetch(`${supabaseUrl}/rest/v1/documents?on_conflict=prdctn_instt_regist_no`, {
            method:'POST', headers:{'apikey':supabaseKey,'Authorization':`Bearer ${supabaseKey}`,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'},
            body:JSON.stringify(docData),
          });
        } catch {}
      }

      stats.total++;
      stats.newCount++;
      if (stats.total % 100 === 0) {
        const spd = (stats.total / ((now()-stats.start)/1000)).toFixed(1);
        log(`  [W${workerId}] ${stats.total.toLocaleString()}건 완료 | ${spd}건/초 | ${elapsed(stats.start)}`);
      }

    } catch (e) {
      stats.errors++;
    }

    await sleep(REQUEST_DELAY);
  }
}

// ── Main ──
async function main() {
  const opts = parseArgs();
  const totalStart = now();
  log(`[병렬 수집] 워커=${opts.workers}개 | 키워드='${opts.keyword}' | 기간=${opts.startDate}~${opts.endDate} | 최대=${opts.maxCount===Infinity?'전체':opts.maxCount}건`);
  log(`[설정] 메타만=${opts.metaOnly} | 파일건너뜀=${opts.skipFiles} | AI건너뜀=${opts.skipAi} | 딜레이=${REQUEST_DELAY}ms`);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const csvPath = path.join(opts.outputDir, 'collection_log.csv');
  if (!fs.existsSync(csvPath))
    fs.writeFileSync(csvPath, '\uFEFF번호,원문등록번호,제목,기관명,생산일자,공개구분\n', 'utf8');

  // SQLite 초기화
  initDB(path.join(opts.outputDir, 'collection.db'));
  log('[SQLite] 초기화 완료');

  // 증분
  log('[증분] 기수집 로딩...');
  const already = await loadCollected(opts.outputDir);
  log(`[증분] 기수집: ${already.size.toLocaleString()}건`);

  // 1단계: 목록 수집
  const cookies = extractCookies();
  if (!cookies) { log('[실패] 쿠키 추출 불가'); return; }

  const allDocs = await collectMetaList(cookies, opts, already);
  if (!allDocs.length) { log('[완료] 신규 문서 없음'); return; }

  if (opts.metaOnly) {
    // 이미 collectMetaList에서 SQLite에 저장됨
    const s = getStats();
    log(`\n[완료] 메타데이터 ${allDocs.length.toLocaleString()}건 수집 | DB 전체: ${s.total.toLocaleString()} | 소요: ${elapsed(totalStart)}`);
    closeDB();
    return;
  }

  // 2단계: 병렬 상세 수집
  log(`\n[2단계] 쿠키+fetch 병렬 상세 수집 (${opts.workers}개 워커)...`);
  const chunkSize = Math.ceil(allDocs.length / opts.workers);
  const stats = { total: 0, newCount: 0, errors: 0, start: now() };

  const workers = [];
  for (let w = 0; w < opts.workers; w++) {
    const chunk = allDocs.slice(w * chunkSize, (w + 1) * chunkSize);
    if (!chunk.length) continue;
    log(`  [W${w}] ${chunk.length}건 할당 (${w*chunkSize+1}~${Math.min((w+1)*chunkSize, allDocs.length)})`);
    workers.push(detailWorker(w, chunk, cookies, opts, csvPath, stats));
  }

  await Promise.all(workers);

  const totalSec = (now() - totalStart) / 1000;
  log(`\n[완료] 신규 ${stats.newCount.toLocaleString()}건 | 에러 ${stats.errors}건 | ${(stats.total/totalSec).toFixed(1)}건/초 | 총 소요: ${elapsed(totalStart)}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
