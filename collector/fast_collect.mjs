#!/usr/bin/env node
/**
 * open.go.kr 원문정보 고속 메타데이터 수집기
 * 목록 API만 사용하여 대량 메타데이터를 빠르게 수집합니다.
 * 상세 페이지/파일 다운로드/Claude 분석 없음.
 *
 * 사용법:
 *   node fast_collect.mjs [옵션]
 *   -k, --keyword     검색어
 *   -s, --start-date  시작일 YYYYMMDD (기본: 1년 전)
 *   -e, --end-date    종료일 YYYYMMDD (기본: 오늘)
 *   -n, --max-count   최대 수집 건수 (기본: 전체)
 *   -o, --output-dir  출력 디렉토리 (기본: ./open_go_kr_docs)
 *   --opp-se-cd       공개구분 (1=공개, 2=부분공개, 빈=전체)
 *
 * 예시:
 *   node fast_collect.mjs -n 120000 -s 20200101   # 전체 수집
 *   node fast_collect.mjs -k "환경부" -n 5000      # 환경부 문서만
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
const BASE_URL = 'https://www.open.go.kr';
const SESSION = 'fast-' + process.pid;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

function fmt(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function now() { return Date.now(); }
function elapsed(s) { const ms = Date.now() - s; return ms < 60000 ? `${(ms/1000).toFixed(1)}s` : `${Math.floor(ms/60000)}m${Math.floor((ms%60000)/1000)}s`; }
function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function htmlDecode(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
}

const OPP = { '1': '공개', '2': '부분공개', '3': '비공개', '5': '열람제한' };

function cheliped(cmds) {
  try {
    const r = execFileSync('node', [CLI_PATH, '--session', SESSION, JSON.stringify(cmds)], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 50*1024*1024, cwd: CWD,
    });
    return JSON.parse(r);
  } catch(e) {
    if (e.stdout) try { return JSON.parse(e.stdout); } catch {}
    return null;
  }
}

// Args
function parseArgs() {
  const args = process.argv.slice(2);
  const today = new Date();
  const yearAgo = new Date(today); yearAgo.setFullYear(today.getFullYear() - 1);
  const opts = {
    keyword: '', startDate: fmt(yearAgo), endDate: fmt(today),
    maxCount: Infinity, outputDir: './open_go_kr_docs', oppSeCd: '',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-k' || a === '--keyword') opts.keyword = args[++i] || '';
    else if (a === '-s' || a === '--start-date') opts.startDate = (args[++i] || '').replace(/-/g, '');
    else if (a === '-e' || a === '--end-date') opts.endDate = (args[++i] || '').replace(/-/g, '');
    else if (a === '-n' || a === '--max-count') opts.maxCount = parseInt(args[++i]) || Infinity;
    else if (a === '-o' || a === '--output-dir') opts.outputDir = args[++i];
    else if (a === '--opp-se-cd') opts.oppSeCd = args[++i];
  }
  return opts;
}

// 기수집 문서 로드
async function loadCollected(outputDir) {
  const set = new Set();
  // CSV
  const csvPath = path.join(outputDir, 'collection_log.csv');
  if (fs.existsSync(csvPath)) {
    fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).forEach(line => {
      const m = line.match(/^\d+,([^,]+),/);
      if (m) set.add(m[1]);
    });
  }
  // DB
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
        off += 1000;
        if (rows.length < 1000) break;
      }
    } catch {}
  }
  return set;
}

// Supabase 배치 저장
async function saveBatch(docs) {
  if (!supabaseUrl || !supabaseKey || docs.length === 0) return;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/documents?on_conflict=prdctn_instt_regist_no`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(docs),
    });
    if (!res.ok) log(`  [DB] 저장 실패: ${res.status}`);
  } catch (e) {
    log(`  [DB] 에러: ${e.message?.slice(0, 50)}`);
  }
}

// 상태 저장
function saveFastState(outputDir, state) {
  fs.writeFileSync(path.join(outputDir, '.fast_state.json'), JSON.stringify(state, null, 2), 'utf8');
}
function loadFastState(outputDir) {
  try {
    const p = path.join(outputDir, '.fast_state.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

async function main() {
  const opts = parseArgs();
  const totalStart = now();
  log(`[고속 수집] 키워드='${opts.keyword}' 기간=${opts.startDate}~${opts.endDate} 최대=${opts.maxCount === Infinity ? '전체' : opts.maxCount}건`);

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const csvPath = path.join(opts.outputDir, 'collection_log.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, '\uFEFF번호,원문등록번호,제목,기관명,담당부서,담당자,생산일자,공개구분,단위업무,분류체계,문서번호,파일목록,키워드\n', 'utf8');
  }

  // 증분수집
  log('[증분] 기수집 문서 로딩...');
  const already = await loadCollected(opts.outputDir);
  log(`[증분] 기수집: ${already.size}건`);

  const prev = loadFastState(opts.outputDir);
  let page = prev?.nextPage || 1;
  let total = 0, newCount = 0, skipCount = 0;
  const perPage = 50;
  const batch = [];

  if (prev) log(`[증분] 재개: 페이지 ${page}부터`);

  // 브라우저 접속
  log('[브라우저] open.go.kr 접속...');
  const nav = cheliped([{ cmd: 'goto', args: [`${BASE_URL}/othicInfo/infoList/orginlInfoList.do`] }]);
  if (!nav?.[0]?.result?.success) { log('[실패] 접속 불가'); return; }
  log('[브라우저] 접속 성공');

  let rtnTotal = 0;

  while (newCount < opts.maxCount) {
    const pageStart = now();

    // 목록 조회 (브라우저 세션에서 AJAX)
    const listJs = `
      var x = new XMLHttpRequest();
      x.open("POST", "/othicInfo/infoList/orginlInfoList.ajax", false);
      x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      x.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      x.send("kwd=${encodeURIComponent(opts.keyword)}&startDate=${opts.startDate}&endDate=${opts.endDate}&insttCd=&insttSeCd=&othbcSeCd=${opts.oppSeCd}&viewPage=${page}&rowPage=${perPage}&sort=d");
      var j = JSON.parse(x.responseText);
      JSON.stringify({ code: j.result && j.result.code, total: j.result && j.result.rtnTotal, list: j.result && j.result.rtnList });
    `.replace(/\n/g, ' ');

    const results = cheliped([{ cmd: 'run-js', args: [listJs] }]);
    let listData = null;
    const val = results?.[0]?.result?.result;
    if (typeof val === 'string') try { listData = JSON.parse(val); } catch {}

    if (!listData || listData.code !== '200') {
      // 세션 만료 → 재접속
      log(`  [경고] 목록 조회 실패 (code: ${listData?.code}), 재접속 시도...`);
      cheliped([{ cmd: 'goto', args: [`${BASE_URL}/othicInfo/infoList/orginlInfoList.do`] }]);
      continue;
    }

    rtnTotal = listData.total || rtnTotal;
    const items = listData.list || [];

    if (page === 1) log(`[목록] 전체 ${rtnTotal.toLocaleString()}건`);

    if (items.length === 0) { log('[완료] 더 이상 결과 없음'); break; }

    let pageNew = 0, pageSkip = 0;
    for (const doc of items) {
      const regNo = doc.PRDCTN_INSTT_REGIST_NO || '';
      if (!regNo) continue;
      total++;

      if (already.has(regNo)) { pageSkip++; skipCount++; continue; }
      already.add(regNo);
      newCount++;
      pageNew++;

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
        `${newCount},"${regNo}","${title.replace(/"/g, '""')}","${insttNm}","${deptNm}","${chargerNm}",${pDate},"${OPP[oppSeCd] || oppSeCd}","${unitJob}","${nstClNm}","${docNo}","${fileNm.replace(/"/g, '""')}","${keywords}"\n`, 'utf8');

      // DB 배치
      batch.push({
        prdctn_instt_regist_no: regNo,
        info_sj: title, doc_no: docNo, proc_instt_nm: insttNm,
        chrg_dept_nm: deptNm, charger_nm: chargerNm,
        prdctn_dt: pDate.length >= 8 ? `${pDate.slice(0,4)}-${pDate.slice(4,6)}-${pDate.slice(6,8)}` : null,
        prdctn_dt_raw: prdnDt || null,
        unit_job_nm: unitJob, opp_se_cd: oppSeCd, opp_se_nm: OPP[oppSeCd] || oppSeCd,
        nst_cl_nm: nstClNm, instt_cd: insttCd, instt_se_cd: insttSeCd,
        keywords: keywords || null, full_dept_nm: fullDept || null,
        original_url: `${BASE_URL}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`,
        status: 'meta_only',
      });

      if (newCount >= opts.maxCount) break;
    }

    // 50건마다 DB 배치 저장
    if (batch.length >= 50) {
      await saveBatch(batch);
      batch.length = 0;
    }

    const speed = ((page * perPage) / ((now() - totalStart) / 1000)).toFixed(1);
    const pct = rtnTotal > 0 ? ((total / rtnTotal) * 100).toFixed(1) : '?';
    log(`  페이지 ${page}: 신규 ${pageNew} | 건너뜀 ${pageSkip} | 누적 ${newCount.toLocaleString()}/${rtnTotal.toLocaleString()} (${pct}%) | ${speed}건/초 | ${elapsed(pageStart)}`);

    // 상태 저장
    saveFastState(opts.outputDir, { nextPage: page + 1, newCount, skipCount, total, timestamp: new Date().toISOString() });

    if (items.length < perPage) break;
    page++;
  }

  // 남은 배치 저장
  if (batch.length > 0) await saveBatch(batch);

  // 상태 정리
  try { fs.unlinkSync(path.join(opts.outputDir, '.fast_state.json')); } catch {}

  cheliped([{ cmd: 'close' }]);
  log(`\n[완료] 신규 ${newCount.toLocaleString()}건 | 건너뜀 ${skipCount.toLocaleString()}건 | 전체 ${rtnTotal.toLocaleString()}건 | 소요: ${elapsed(totalStart)}`);
  log(`[파일] ${csvPath}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
