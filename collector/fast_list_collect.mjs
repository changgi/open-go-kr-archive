#!/usr/bin/env node
/**
 * 쿠키+fetch 기반 빠른 목록 수집기
 * 브라우저 없이 fetch로 직접 목록 API 호출
 * 7.8M 문서를 최대한 빠르게 수집
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, upsertDocuments, getCollectedSet, getStats, closeDB } from './local_db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const CLI_PATH = path.join(__dirname, 'cheliped-browser', 'scripts', 'cheliped-cli.mjs');
const CWD = path.join(__dirname, 'cheliped-browser', 'scripts');
const BASE = 'https://www.open.go.kr';
const OPP = {'1':'공개','2':'부분공개','3':'비공개','5':'열람제한'};

function ts() { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function htmlDecode(s) { return (s||'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Args
const args = process.argv.slice(2);
let outputDir = './full_collection';
let maxCount = Infinity;
let startPage = 1;
let workers = 8;  // 병렬 fetch 수
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') outputDir = args[++i];
  if (args[i] === '-n') maxCount = parseInt(args[++i]) || Infinity;
  if (args[i] === '-p') startPage = parseInt(args[++i]) || 1;
  if (args[i] === '-w') workers = parseInt(args[++i]) || 8;
}
fs.mkdirSync(outputDir, { recursive: true });

// 쿠키 추출
function extractCookies() {
  log('[쿠키] 추출 중...');
  try {
    const r = execFileSync('node', [CLI_PATH, JSON.stringify([
      {cmd:'goto',args:[`${BASE}/othicInfo/infoList/orginlInfoList.do`]},
      {cmd:'run-js',args:['document.cookie']},{cmd:'close'},
    ])], {encoding:'utf8',timeout:120000,cwd:CWD});
    const c = JSON.parse(r)[1]?.result?.result;
    if(c){log('[쿠키] 성공');return c;}
  }catch(e){if(e.stdout){try{const c=JSON.parse(e.stdout)[1]?.result?.result;if(c)return c;}catch{}}}
  log('[쿠키] 실패');return null;
}

function hdrs(cookies) {
  return {
    'Cookie': cookies,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': `${BASE}/othicInfo/infoList/orginlInfoList.do`,
  };
}

// 단일 페이지 fetch
async function fetchPage(cookies, page) {
  const body = `kwd=&startDate=20210101&endDate=20260409&insttCd=&insttSeCd=&othbcSeCd=&viewPage=${page}&rowPage=50&sort=d`;
  const res = await fetch(`${BASE}/othicInfo/infoList/orginlInfoList.ajax`, {
    method: 'POST', headers: hdrs(cookies), body,
  });
  const json = await res.json();
  if (json.result?.code !== '200') return null;
  return { total: json.result.rtnTotal, list: json.result.rtnList || [] };
}

// 메인
async function main() {
  const db = initDB(path.join(outputDir, 'collection.db'));
  const already = getCollectedSet();
  log(`기수집: ${already.size.toLocaleString()}건`);

  const cookies = extractCookies();
  if (!cookies) { log('쿠키 추출 실패'); process.exit(1); }

  // 첫 페이지로 전체 건수 확인
  const first = await fetchPage(cookies, 1);
  if (!first) { log('API 호출 실패'); process.exit(1); }
  const rtnTotal = first.total;
  const totalPages = Math.ceil(rtnTotal / 50);
  log(`전체: ${rtnTotal.toLocaleString()}건 (${totalPages.toLocaleString()}페이지)`);

  // state 복원
  const stPath = path.join(outputDir, '.fast_list_state.json');
  try {
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    if (st.nextPage > startPage) {
      startPage = st.nextPage;
      log(`[재개] 페이지 ${startPage}부터`);
    }
  } catch {}

  let page = startPage;
  let newDocs = 0;
  let batchBuf = [];
  let errors = 0;
  const csvPath = path.join(outputDir, 'collection_log.csv');
  const t0 = Date.now();

  while (page <= totalPages && newDocs < maxCount) {
    // 병렬 fetch (workers 페이지 동시)
    const pages = [];
    for (let i = 0; i < workers && page + i <= totalPages; i++) {
      pages.push(page + i);
    }

    const results = await Promise.allSettled(
      pages.map(p => fetchPage(cookies, p))
    );

    let pageNewCount = 0;
    let emptyCount = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'fulfilled' || !r.value) {
        errors++;
        if (errors > 20) {
          log(`[중단] 연속 오류 ${errors}회`);
          fs.writeFileSync(stPath, JSON.stringify({ nextPage: pages[i] }));
          break;
        }
        continue;
      }
      errors = 0;
      const items = r.value.list;
      if (!items.length) { emptyCount++; continue; }

      for (const doc of items) {
        const regNo = doc.PRDCTN_INSTT_REGIST_NO;
        if (!regNo || already.has(regNo)) continue;
        already.add(regNo);
        pageNewCount++;
        batchBuf.push({
          prdctn_instt_regist_no: regNo,
          info_sj: htmlDecode(doc.INFO_SJ || ''),
          doc_no: htmlDecode(doc.DOC_NO || ''),
          proc_instt_nm: htmlDecode(doc.PROC_INSTT_NM || ''),
          chrg_dept_nm: htmlDecode(doc.CHRG_DEPT_NM || ''),
          charger_nm: htmlDecode(doc.CHARGER_NM || ''),
          prdctn_dt: (doc.PRDCTN_DT||'').length >= 8 ?
            `${doc.PRDCTN_DT.slice(0,4)}-${doc.PRDCTN_DT.slice(4,6)}-${doc.PRDCTN_DT.slice(6,8)}` : null,
          prdctn_dt_raw: doc.PRDCTN_DT || '',
          unit_job_nm: htmlDecode(doc.UNIT_JOB_NM || ''),
          opp_se_cd: doc.OTHBC_SE_CD || '',
          opp_se_nm: OPP[doc.OTHBC_SE_CD] || doc.OTHBC_SE_CD || '',
          nst_cl_nm: htmlDecode(doc.RQEST_TY_THEMA_NM || ''),
          instt_cd: doc.INSTT_CD || '',
          instt_se_cd: doc.INSTT_SE_CD || '',
          keywords: (doc.tma_kwd || '').replace(/\n/g, ', ').trim() || null,
          full_dept_nm: htmlDecode(doc.NFLST_CHRG_DEPT_NM || '') || null,
          status: 'meta_only',
        });
      }
    }

    // 배치 DB 저장 (1000건마다)
    if (batchBuf.length >= 1000) {
      upsertDocuments(batchBuf);
      newDocs += batchBuf.length;
      batchBuf = [];
    }

    page += pages.length;

    // 로그 (50페이지마다)
    if (page % 50 < workers) {
      const elapsed = (Date.now() - t0) / 1000;
      const pps = ((page - startPage) / elapsed).toFixed(1);
      const eta = Math.round((totalPages - page) / parseFloat(pps) / 60);
      const s = getStats();
      log(`페이지 ${page.toLocaleString()}/${totalPages.toLocaleString()} | 신규 ${newDocs.toLocaleString()} | DB ${s.total.toLocaleString()} | ${pps}p/s | ETA ${eta}분`);
    }

    // 상태 저장 (100페이지마다)
    if (page % 100 < workers) {
      fs.writeFileSync(stPath, JSON.stringify({ nextPage: page }));
    }

    if (emptyCount === pages.length) {
      log('[목록] 빈 페이지 도달 — 종료');
      break;
    }

    if (errors > 20) break;

    // 속도 제한
    await sleep(100);
  }

  // 남은 배치 저장
  if (batchBuf.length > 0) {
    upsertDocuments(batchBuf);
    newDocs += batchBuf.length;
  }

  const s = getStats();
  log(`=== 완료 ===`);
  log(`신규: ${newDocs.toLocaleString()}건`);
  log(`DB 전체: ${s.total.toLocaleString()} | ok: ${s.ok.toLocaleString()} | meta_only: ${s.meta_only.toLocaleString()}`);
  log(`소요: ${((Date.now()-t0)/1000/60).toFixed(1)}분`);

  try { fs.unlinkSync(stPath); } catch {}
  closeDB();
}

main().catch(e => { console.error(e); process.exit(1); });
