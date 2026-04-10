#!/usr/bin/env node
/**
 * 연도별/월별 분할 목록 수집기
 *
 * open.go.kr API는 깊은 오프셋에서 빈 결과를 반환하므로,
 * 날짜 범위를 좁게 (월별) 나눠서 요청해야 전체 수집 가능.
 *
 * 브라우저(cheliped)로 목록 API 호출 → SQLite 직접 저장
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, upsertDocuments, getCollectedSet, getStats, closeDB } from './local_db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
let startYear = 2010;
let endYear = new Date().getFullYear();
let resumeFrom = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') outputDir = args[++i];
  if (args[i] === '--start-year') startYear = parseInt(args[++i]);
  if (args[i] === '--end-year') endYear = parseInt(args[++i]);
  if (args[i] === '--resume') resumeFrom = args[++i]; // e.g. "2015-03"
}
fs.mkdirSync(outputDir, { recursive: true });

// 월 범위 생성 [startYear-01, ..., endYear-12]
function buildMonthRanges(fromYear, toYear) {
  const ranges = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const ys = y.toString();
      const ms = m.toString().padStart(2, '0');
      const lastDay = new Date(y, m, 0).getDate();
      ranges.push({
        key: `${ys}-${ms}`,
        start: `${ys}${ms}01`,
        end: `${ys}${ms}${lastDay.toString().padStart(2,'0')}`,
      });
    }
  }
  return ranges;
}

// 20페이지 배치 브라우저 호출
function fetchBatchBrowser(startDate, endDate, startPage, batchSize = 20) {
  const endPage = startPage + batchSize - 1;
  const js = `
var allItems=[];var total=0;var code="";var lastPage=${startPage};
for(var p=${startPage};p<=${endPage};p++){
  var x=new XMLHttpRequest();x.open("POST","/othicInfo/infoList/orginlInfoList.ajax",false);
  x.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
  x.setRequestHeader("X-Requested-With","XMLHttpRequest");
  x.send("kwd=&startDate=${startDate}&endDate=${endDate}&insttCd=&insttSeCd=&othbcSeCd=&viewPage="+p+"&rowPage=50&sort=d");
  var j=JSON.parse(x.responseText);
  code=j.result&&j.result.code;if(code!=="200")break;
  total=j.result.rtnTotal;lastPage=p;
  var list=j.result.rtnList||[];
  for(var i=0;i<list.length;i++)allItems.push(list[i]);
  if(list.length<50)break;
}
JSON.stringify({code:code,total:total,count:allItems.length,endPage:lastPage,list:allItems});
  `.replace(/\n/g,' ');

  let results;
  try {
    const r = execFileSync('node', [CLI_PATH, JSON.stringify([
      {cmd:'goto',args:[`${BASE}/othicInfo/infoList/orginlInfoList.do`]},
      {cmd:'run-js',args:[js]},
    ])], {encoding:'utf8',timeout:240000,maxBuffer:100*1024*1024,cwd:CWD});
    results = JSON.parse(r);
  } catch(e) {
    if(e.stdout) { try { results = JSON.parse(e.stdout); } catch {} }
  }

  const val = results?.[1]?.result?.result;
  if (typeof val !== 'string') return null;
  try { return JSON.parse(val); } catch { return null; }
}

async function main() {
  initDB(path.join(outputDir, 'collection.db'));
  const already = getCollectedSet();
  log(`SQLite 초기화 | 기수집: ${already.size.toLocaleString()}건`);

  const ranges = buildMonthRanges(startYear, endYear);
  log(`날짜 범위: ${startYear}-01 ~ ${endYear}-12 (${ranges.length}개월)`);

  // state 복원
  const stPath = path.join(outputDir, '.year_range_state.json');
  let startIdx = 0;
  if (resumeFrom) {
    startIdx = ranges.findIndex(r => r.key === resumeFrom);
    if (startIdx < 0) startIdx = 0;
    log(`[재개] ${resumeFrom} 부터`);
  } else {
    try {
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      startIdx = ranges.findIndex(r => r.key === st.currentRange);
      if (startIdx < 0) startIdx = 0;
      log(`[재개] ${st.currentRange} 부터`);
    } catch {}
  }

  let totalNew = 0;
  const t0 = Date.now();

  for (let ri = startIdx; ri < ranges.length; ri++) {
    const range = ranges[ri];
    fs.writeFileSync(stPath, JSON.stringify({ currentRange: range.key, totalNew }));

    let page = 1, retries = 0, rangeNew = 0, rangeTotal = -1;

    while (true) {
      const data = fetchBatchBrowser(range.start, range.end, page, 20);
      if (!data || data.code !== '200') {
        retries++;
        if (retries >= 3) { log(`  [${range.key}] 재시도 한계, 다음 범위로`); break; }
        log(`  [${range.key}] 재시도 ${retries}/3`);
        await sleep(3000);
        continue;
      }
      retries = 0;

      if (rangeTotal < 0) rangeTotal = data.total || 0;
      const items = data.list || [];
      if (!items.length) break;

      // SQLite 배치 저장
      const newDocs = [];
      for (const doc of items) {
        const regNo = doc.PRDCTN_INSTT_REGIST_NO;
        if (!regNo || already.has(regNo)) continue;
        already.add(regNo);
        newDocs.push({
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
      if (newDocs.length > 0) {
        try { upsertDocuments(newDocs); } catch {}
        rangeNew += newDocs.length;
        totalNew += newDocs.length;
      }

      const endPage = data.endPage || page + 19;
      if (items.length < 20 * 50 || page > Math.ceil(rangeTotal/50)) {
        log(`  [${range.key}] 페이지 ${page}~${endPage}: +${newDocs.length} | 범위 ${rangeNew}/${rangeTotal} | 완료`);
        break;
      }
      if (ri % 1 === 0 && endPage % 100 < 20) {
        log(`  [${range.key}] 페이지 ${endPage}/${Math.ceil(rangeTotal/50)} | 신규 ${rangeNew.toLocaleString()}/${rangeTotal.toLocaleString()}`);
      }
      page = endPage + 1;
    }

    const s = getStats();
    const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
    log(`[${range.key}] 범위 완료: +${rangeNew.toLocaleString()} (범위 ${rangeTotal.toLocaleString()}) | DB ${s.total.toLocaleString()} | ${elapsed}분`);
  }

  try { fs.unlinkSync(stPath); } catch {}
  const s = getStats();
  log(`=== 완료 ===`);
  log(`총 신규: ${totalNew.toLocaleString()}건`);
  log(`DB 전체: ${s.total.toLocaleString()} | ok: ${s.ok.toLocaleString()} | meta_only: ${s.meta_only.toLocaleString()}`);
  log(`소요: ${((Date.now()-t0)/1000/60).toFixed(1)}분`);

  closeDB();
}

main().catch(e => { console.error(e); process.exit(1); });
