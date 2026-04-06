#!/usr/bin/env node
/**
 * open.go.kr 원문정보 초고속 수집기 (Turbo Mode)
 *
 * 브라우저로 1회 접속 → 쿠키 추출 → Node.js fetch로 직접 AJAX 호출
 * Chrome 오버헤드 제거, 순수 HTTP 속도로 수집
 *
 * 예상 속도: ~500건/초 (11만건 = ~4분)
 *
 * 사용법:
 *   node turbo_collect.mjs [옵션]
 *   -s, --start-date  시작일 YYYYMMDD (기본: 5년 전)
 *   -e, --end-date    종료일 YYYYMMDD (기본: 오늘)
 *   -n, --max-count   최대 수집 건수 (기본: 전체)
 *   -k, --keyword     검색어
 *   -o, --output-dir  출력 디렉토리
 *   --opp-se-cd       공개구분
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env 로드
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
const AJAX_URL = `${BASE}/othicInfo/infoList/orginlInfoList.ajax`;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

function now() { return Date.now(); }
function elapsed(s) { const ms=Date.now()-s; return ms<60000?`${(ms/1000).toFixed(1)}s`:`${Math.floor(ms/60000)}m${Math.floor((ms%60000)/1000)}s`; }
function ts() { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }
function fmt(d) { return d.toISOString().slice(0,10).replace(/-/g,''); }
function htmlDecode(s) { return (s||'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'"); }
const OPP = {'1':'공개','2':'부분공개','3':'비공개','5':'열람제한'};

// Args
function parseArgs() {
  const args = process.argv.slice(2);
  const today = new Date();
  const ago = new Date(today); ago.setFullYear(today.getFullYear() - 5);
  const opts = {
    keyword:'', startDate:fmt(ago), endDate:fmt(today),
    maxCount:Infinity, outputDir:'./open_go_kr_docs', oppSeCd:'',
  };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='-k'||a==='--keyword')opts.keyword=args[++i]||'';
    else if(a==='-s'||a==='--start-date')opts.startDate=(args[++i]||'').replace(/-/g,'');
    else if(a==='-e'||a==='--end-date')opts.endDate=(args[++i]||'').replace(/-/g,'');
    else if(a==='-n'||a==='--max-count')opts.maxCount=parseInt(args[++i])||Infinity;
    else if(a==='-o'||a==='--output-dir')opts.outputDir=args[++i];
    else if(a==='--opp-se-cd')opts.oppSeCd=args[++i];
  }
  return opts;
}

// Step 1: 브라우저로 접속하여 쿠키 추출
function extractCookies() {
  log('[쿠키] 브라우저로 접속하여 세션 쿠키 추출 중...');
  const session = 'turbo-' + process.pid;
  try {
    const r = execFileSync('node', [CLI_PATH, '--session', session, JSON.stringify([
      { cmd: 'goto', args: [`${BASE}/othicInfo/infoList/orginlInfoList.do`] },
      { cmd: 'run-js', args: ['document.cookie'] },
    ])], { encoding: 'utf8', timeout: 120000, cwd: CWD });
    const parsed = JSON.parse(r);
    const cookies = parsed[1]?.result?.result || '';

    // 종료
    try { execFileSync('node', [CLI_PATH, '--session', session, JSON.stringify([{cmd:'close'}])], {encoding:'utf8',timeout:10000,cwd:CWD}); } catch{}

    if (cookies) {
      log(`[쿠키] 추출 성공: ${cookies.slice(0, 60)}...`);
      return cookies;
    }
  } catch (e) {
    log(`[쿠키] 브라우저 에러: ${e.message?.slice(0, 50)}`);
  }
  return null;
}

// Step 2: Node.js fetch로 직접 AJAX 호출
async function fetchPage(page, cookies, opts) {
  const body = new URLSearchParams({
    kwd: opts.keyword,
    startDate: opts.startDate,
    endDate: opts.endDate,
    insttCd: '', insttSeCd: '',
    othbcSeCd: opts.oppSeCd,
    viewPage: String(page),
    rowPage: '50',
    sort: 'd',
  });

  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookies,
      'Referer': `${BASE}/othicInfo/infoList/orginlInfoList.do`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    body: body.toString(),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data?.result;
}

// 기수집 로드
async function loadCollected(outputDir) {
  const set = new Set();
  const csvPath = path.join(outputDir, 'collection_log.csv');
  if (fs.existsSync(csvPath)) {
    fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).forEach(line => {
      const m = line.match(/^\d+,"?([^",]+)/);
      if (m) set.add(m[1]);
    });
  }
  if (supabaseUrl && supabaseKey) {
    try {
      let off = 0;
      while (true) {
        const r = await fetch(`${supabaseUrl}/rest/v1/documents?select=prdctn_instt_regist_no&limit=1000&offset=${off}`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        });
        if (!r.ok) break;
        const rows = await r.json();
        if (!rows.length) break;
        rows.forEach(r => { if (r.prdctn_instt_regist_no) set.add(r.prdctn_instt_regist_no); });
        off += 1000; if (rows.length < 1000) break;
      }
    } catch {}
  }
  return set;
}

// Supabase 배치
async function saveBatch(docs) {
  if (!supabaseUrl || !supabaseKey || !docs.length) return;
  // 100건씩 분할
  for (let i = 0; i < docs.length; i += 100) {
    const chunk = docs.slice(i, i + 100);
    try {
      await fetch(`${supabaseUrl}/rest/v1/documents?on_conflict=prdctn_instt_regist_no`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(chunk),
      });
    } catch {}
  }
}

// 상태
function saveState(dir, s) { fs.writeFileSync(path.join(dir, '.turbo_state.json'), JSON.stringify(s), 'utf8'); }
function loadState(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, '.turbo_state.json'), 'utf8')); } catch { return null; } }

async function main() {
  const opts = parseArgs();
  const totalStart = now();
  log(`[Turbo 수집] 키워드='${opts.keyword}' 기간=${opts.startDate}~${opts.endDate} 최대=${opts.maxCount === Infinity ? '전체' : opts.maxCount}건`);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const csvPath = path.join(opts.outputDir, 'collection_log.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, '\uFEFF번호,원문등록번호,제목,기관명,담당부서,담당자,생산일자,공개구분,단위업무,분류체계,문서번호,파일목록,키워드,소속전체명\n', 'utf8');
  }

  // 증분
  log('[증분] 기수집 문서 로딩...');
  const already = await loadCollected(opts.outputDir);
  log(`[증분] 기수집: ${already.size.toLocaleString()}건`);

  // 쿠키 추출
  const cookies = extractCookies();
  if (!cookies) {
    log('[실패] 쿠키 추출 불가. 브라우저 접속을 확인하세요.');
    return;
  }

  // 테스트: 쿠키로 직접 요청
  log('[테스트] Node.js fetch로 직접 AJAX 호출...');
  const testResult = await fetchPage(1, cookies, opts);
  if (!testResult || testResult.code === '491') {
    log(`[실패] 직접 요청 차단됨 (code: ${testResult?.code}). 쿠키가 유효하지 않습니다.`);
    log('[대안] fast_collect.mjs를 사용하세요 (브라우저 세션 유지).');
    return;
  }
  const rtnTotal = testResult.rtnTotal || 0;
  log(`[성공] 전체 ${rtnTotal.toLocaleString()}건 확인 (code: ${testResult.code})`);

  // 수집 시작
  const prev = loadState(opts.outputDir);
  let page = prev?.nextPage || 1;
  let newCount = prev?.newCount || 0;
  let skipCount = prev?.skipCount || 0;
  let totalProcessed = prev?.totalProcessed || 0;
  const batch = [];
  const perPage = 50;
  const totalPages = Math.ceil(rtnTotal / perPage);

  if (prev) log(`[증분] 재개: 페이지 ${page}/${totalPages}`);

  let consecutiveErrors = 0;

  while (newCount < opts.maxCount && page <= totalPages) {
    const pageStart = now();

    const result = await fetchPage(page, cookies, opts);

    if (!result || result.code !== '200') {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        log(`[중단] 연속 ${consecutiveErrors}회 실패. 쿠키 만료. 재실행하세요.`);
        saveState(opts.outputDir, { nextPage: page, newCount, skipCount, totalProcessed, timestamp: new Date().toISOString() });
        break;
      }
      log(`  [경고] 페이지 ${page} 실패 (${consecutiveErrors}/5), 1초 후 재시도`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    consecutiveErrors = 0;

    const items = result.rtnList || [];
    if (!items.length) break;

    let pageNew = 0;
    for (const doc of items) {
      const regNo = doc.PRDCTN_INSTT_REGIST_NO || '';
      if (!regNo) continue;
      totalProcessed++;

      if (already.has(regNo)) { skipCount++; continue; }
      already.add(regNo);
      newCount++; pageNew++;

      const title = htmlDecode(doc.INFO_SJ || '');
      const prdnDt = doc.PRDCTN_DT || '';
      const pDate = doc.P_DATE || prdnDt.slice(0, 8);
      const insttNm = htmlDecode(doc.PROC_INSTT_NM || '');
      const deptNm = htmlDecode(doc.CHRG_DEPT_NM || '');
      const chargerNm = htmlDecode(doc.CHARGER_NM || '');
      const docNo = htmlDecode(doc.DOC_NO || '');
      const unitJob = htmlDecode(doc.UNIT_JOB_NM || '');
      const oppSeCd = doc.OTHBC_SE_CD || '';
      const nstClNm = htmlDecode(doc.RQEST_TY_THEMA_NM || '');
      const insttCd = doc.INSTT_CD || '';
      const insttSeCd = doc.INSTT_SE_CD || '';
      const fileNm = htmlDecode(doc.FILE_NM || '');
      const keywords = (doc.tma_kwd || '').replace(/\n/g, ', ').trim();
      const fullDept = htmlDecode(doc.NFLST_CHRG_DEPT_NM || '');
      const nstSeCd = regNo.slice(0, 3) || insttSeCd;

      // CSV
      fs.appendFileSync(csvPath,
        `${newCount},"${regNo}","${title.replace(/"/g,'""')}","${insttNm}","${deptNm}","${chargerNm}",${pDate},"${OPP[oppSeCd]||oppSeCd}","${unitJob}","${nstClNm}","${docNo}","${fileNm.replace(/"/g,'""')}","${keywords}","${fullDept}"\n`, 'utf8');

      batch.push({
        prdctn_instt_regist_no: regNo, info_sj: title, doc_no: docNo,
        proc_instt_nm: insttNm, chrg_dept_nm: deptNm, charger_nm: chargerNm,
        prdctn_dt: pDate.length >= 8 ? `${pDate.slice(0,4)}-${pDate.slice(4,6)}-${pDate.slice(6,8)}` : null,
        prdctn_dt_raw: prdnDt || null,
        unit_job_nm: unitJob, opp_se_cd: oppSeCd, opp_se_nm: OPP[oppSeCd] || oppSeCd,
        nst_cl_nm: nstClNm, instt_cd: insttCd, instt_se_cd: insttSeCd,
        keywords: keywords || null, full_dept_nm: fullDept || null,
        original_url: `${BASE}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`,
        status: 'meta_only',
      });

      if (newCount >= opts.maxCount) break;
    }

    // 배치 저장 (500건마다)
    if (batch.length >= 500) {
      await saveBatch(batch);
      batch.length = 0;
    }

    // 진행 로그 (50페이지마다 또는 매 10페이지)
    if (page % 10 === 0 || page <= 5) {
      const elapsedSec = (now() - totalStart) / 1000;
      const speed = (totalProcessed / elapsedSec).toFixed(0);
      const pct = ((page / totalPages) * 100).toFixed(1);
      const eta = totalPages > 0 ? Math.round(((totalPages - page) * (elapsedSec / page))) : 0;
      const etaMin = Math.floor(eta / 60);
      const etaSec = eta % 60;
      log(`  페이지 ${page.toLocaleString()}/${totalPages.toLocaleString()} (${pct}%) | 신규 ${newCount.toLocaleString()} | ${speed}건/초 | ETA ${etaMin}분${etaSec}초`);
    }

    // 상태 저장 (100페이지마다)
    if (page % 100 === 0) {
      saveState(opts.outputDir, { nextPage: page + 1, newCount, skipCount, totalProcessed, timestamp: new Date().toISOString() });
    }

    page++;
    // 서버 부하 방지: 10페이지마다 200ms 대기
    if (page % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }

  // 남은 배치 저장
  if (batch.length > 0) await saveBatch(batch);

  // 상태 정리
  try { fs.unlinkSync(path.join(opts.outputDir, '.turbo_state.json')); } catch {}

  const totalSec = (now() - totalStart) / 1000;
  log(`\n[완료] 신규 ${newCount.toLocaleString()}건 | 건너뜀 ${skipCount.toLocaleString()}건 | 전체 ${rtnTotal.toLocaleString()}건`);
  log(`[속도] ${(totalProcessed / totalSec).toFixed(0)}건/초 | 총 소요: ${elapsed(totalStart)}`);
  log(`[파일] ${csvPath}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
