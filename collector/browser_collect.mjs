#!/usr/bin/env node
/**
 * open.go.kr 원문정보 브라우저 기반 수집기
 * cheliped-browser(Chrome CDP)로 세션을 유지하며 목록 API를 호출합니다.
 *
 * 사용법:
 *   node browser_collect.mjs [옵션]
 *   -k, --keyword     검색어 (기본: 빈문자열)
 *   -s, --start-date  시작일 YYYYMMDD (기본: 30일 전)
 *   -e, --end-date    종료일 YYYYMMDD (기본: 오늘)
 *   -n, --max-count   최대 수집 건수 (기본: 10)
 *   -o, --output-dir  출력 디렉토리 (기본: ./open_go_kr_docs)
 *   --opp-se-cd       공개구분 (1=공개, 2=부분공개, 빈=전체)
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, 'cheliped-browser', 'scripts', 'cheliped-cli.mjs');
const CWD = path.join(__dirname, 'cheliped-browser', 'scripts');
const BASE_URL = 'https://www.open.go.kr';

// ── Args ──
function parseArgs() {
  const args = process.argv.slice(2);
  const today = new Date();
  const ago = new Date(today); ago.setDate(today.getDate() - 30);
  const opts = {
    keyword: '', startDate: fmt(ago), endDate: fmt(today),
    maxCount: 10, outputDir: './open_go_kr_docs', oppSeCd: '',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-k' || a === '--keyword') opts.keyword = args[++i] || '';
    else if (a === '-s' || a === '--start-date') opts.startDate = (args[++i] || '').replace(/-/g, '');
    else if (a === '-e' || a === '--end-date') opts.endDate = (args[++i] || '').replace(/-/g, '');
    else if (a === '-n' || a === '--max-count') opts.maxCount = parseInt(args[++i]);
    else if (a === '-o' || a === '--output-dir') opts.outputDir = args[++i];
    else if (a === '--opp-se-cd') opts.oppSeCd = args[++i];
  }
  return opts;
}

function fmt(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function sanitize(name, maxLen = 40) {
  return name.replace(/[\\/:"*?<>|\[\]「」\r\n&;]/g, '_')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .slice(0, maxLen).trim() || 'untitled';
}
function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, s = b;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(1)} ${u[i]}`;
}
function htmlDecode(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
}
function formatDate(d) {
  if (!d || d.length < 8) return '-';
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
}

const OPP_LABELS = { '1': '공개', '2': '부분공개', '3': '비공개', '5': '열람제한' };

// ── Cheliped ──
function cheliped(commands) {
  const tmpFile = path.join(__dirname, '_cmd.json');
  fs.writeFileSync(tmpFile, JSON.stringify(commands), 'utf8');

  const wrapperFile = path.join(__dirname, '_run.cjs');
  fs.writeFileSync(wrapperFile, `
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    const cmds = fs.readFileSync(${JSON.stringify(tmpFile)}, 'utf8');
    const r = execFileSync('node', [${JSON.stringify(CLI_PATH)}, cmds], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024,
      cwd: ${JSON.stringify(CWD)}
    });
    process.stdout.write(r);
  `, 'utf8');

  try {
    return JSON.parse(execFileSync('node', [wrapperFile], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024,
    }));
  } catch (e) {
    console.error('[cheliped]', (e.stdout || e.message || '').slice(0, 200));
    return null;
  }
}

function runJsInSession(jsCode) {
  const results = cheliped([{ cmd: 'run-js', args: [jsCode] }]);
  if (!results?.[0]?.result?.result) return null;
  const val = results[0].result.result;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
  return val;
}

// ── Supabase (optional) ──
let supabaseUrl = process.env.SUPABASE_URL;
let supabaseKey = process.env.SUPABASE_SERVICE_KEY;

function syncToSupabase(doc) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const js = `
      var x = new XMLHttpRequest();
      x.open("POST", "${supabaseUrl}/rest/v1/documents", false);
      x.setRequestHeader("apikey", "${supabaseKey}");
      x.setRequestHeader("Authorization", "Bearer ${supabaseKey}");
      x.setRequestHeader("Content-Type", "application/json");
      x.setRequestHeader("Prefer", "resolution=merge-duplicates");
      x.send(JSON.stringify(${JSON.stringify(doc)}));
      x.status;
    `.replace(/\n/g, ' ');
    runJsInSession(js);
  } catch (e) {
    // Supabase sync failure is non-fatal
  }
}

// ── Main ──
async function main() {
  const opts = parseArgs();
  console.log(`[수집 시작] 키워드='${opts.keyword}' 기간=${opts.startDate}~${opts.endDate} 최대=${opts.maxCount}건`);

  // Navigate to site
  console.log('[브라우저] open.go.kr 접속 중...');
  const navResult = cheliped([
    { cmd: 'goto', args: [`${BASE_URL}/othicInfo/infoList/orginlInfoList.do`] },
  ]);
  if (!navResult?.[0]?.result?.success) {
    console.error('[실패] 사이트 접속 불가');
    return;
  }
  console.log('[브라우저] 접속 성공');

  // Prepare output
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const csvPath = path.join(opts.outputDir, 'collection_log.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, '번호,원문등록번호,제목,처리시각,상태,공개구분,기관명,비고\n', 'utf8');
  }

  // Paginate and collect
  let collected = 0;
  let page = 1;
  const perPage = 50;

  while (collected < opts.maxCount) {
    const remaining = opts.maxCount - collected;
    const fetchCount = Math.min(perPage, remaining);

    console.log(`\n[페이지 ${page}] 조회 중... (수집 ${collected}/${opts.maxCount})`);

    const listJs = `
      var x = new XMLHttpRequest();
      x.open("POST", "/othicInfo/infoList/orginlInfoList.ajax", false);
      x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      x.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      x.send("kwd=${encodeURIComponent(opts.keyword)}&startDate=${opts.startDate}&endDate=${opts.endDate}&insttCd=&insttSeCd=&othbcSeCd=${opts.oppSeCd}&viewPage=${page}&rowPage=${perPage}&sort=d");
      var j = JSON.parse(x.responseText);
      JSON.stringify({
        code: j.result && j.result.code,
        total: j.result && j.result.rtnTotal,
        list: j.result && j.result.rtnList
      });
    `.replace(/\n/g, ' ');

    const listData = runJsInSession(listJs);
    if (!listData || listData.code !== '200') {
      console.error('[실패] 목록 조회 오류:', listData?.code);
      break;
    }

    const totalFound = listData.total || 0;
    const items = listData.list || [];

    if (page === 1) {
      console.log(`[목록] 전체 ${totalFound}건 발견`);
    }

    if (items.length === 0) {
      console.log('[완료] 더 이상 결과 없음');
      break;
    }

    const batch = items.slice(0, remaining);

    for (const doc of batch) {
      collected++;
      const regNo = doc.PRDCTN_INSTT_REGIST_NO || '';
      const title = htmlDecode(doc.INFO_SJ || '(제목 없음)');
      const pDate = doc.P_DATE || '';
      const insttNm = htmlDecode(doc.PROC_INSTT_NM || '');
      const deptNm = htmlDecode(doc.CHRG_DEPT_NM || '');
      const chargerNm = htmlDecode(doc.CHARGER_NM || '');
      const docNo = htmlDecode(doc.DOC_NO || '');
      const unitJob = htmlDecode(doc.UNIT_JOB_NM || '');
      const oppSeCd = doc.OTHBC_SE_CD || '';
      const oppLabel = OPP_LABELS[oppSeCd] || oppSeCd;
      const nstClNm = htmlDecode(doc.RQEST_TY_THEMA_NM || '');
      const insttCd = doc.INSTT_CD || '';
      const insttSeCd = doc.INSTT_SE_CD || '';
      const fileNm = htmlDecode(doc.FILE_NM || '');

      const folderName = `${collected}_${sanitize(title)}`;
      const folderPath = path.join(opts.outputDir, folderName);

      console.log(`  [${collected}] ${title.slice(0, 55)} (${insttNm})`);

      // Resume
      if (fs.existsSync(folderPath)) {
        console.log('    → 건너뜀 (이미 존재)');
        continue;
      }

      fs.mkdirSync(folderPath, { recursive: true });

      // metadata.md
      let md = `# ${title}\n\n## 메타데이터\n\n| 항목 | 내용 |\n|------|------|\n`;
      md += `| 제목 | ${title} |\n`;
      md += `| 문서번호 | ${docNo} |\n`;
      md += `| 기관명 | ${insttNm} |\n`;
      md += `| 담당부서 | ${deptNm} |\n`;
      md += `| 담당자 | ${chargerNm} |\n`;
      md += `| 생산일자 | ${formatDate(pDate)} |\n`;
      md += `| 단위업무 | ${unitJob} |\n`;
      md += `| 공개여부 | ${oppLabel} |\n`;
      md += `| 분류체계 | ${nstClNm} |\n`;
      md += `| 원문등록번호 | ${regNo} |\n`;
      md += `| 기관코드 | ${insttCd} |\n`;
      if (fileNm) {
        md += `\n## 파일 목록\n\n`;
        fileNm.split('|').forEach(f => { if (f.trim()) md += `- ${f.trim()}\n`; });
      }
      md += `\n## 원문 링크\n\n${BASE_URL}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}\n`;

      fs.writeFileSync(path.join(folderPath, 'metadata.md'), md, 'utf8');

      // Supabase sync
      syncToSupabase({
        prdctn_instt_regist_no: regNo,
        info_sj: title,
        doc_no: docNo,
        proc_instt_nm: insttNm,
        chrg_dept_nm: deptNm,
        charger_nm: chargerNm,
        prdctn_dt: pDate.length >= 8 ? `${pDate.slice(0,4)}-${pDate.slice(4,6)}-${pDate.slice(6,8)}` : null,
        unit_job_nm: unitJob,
        opp_se_cd: oppSeCd,
        opp_se_nm: oppLabel,
        nst_cl_nm: nstClNm,
        instt_cd: insttCd,
        instt_se_cd: insttSeCd,
        status: 'ok',
      });

      // CSV log
      fs.appendFileSync(csvPath,
        `${collected},${regNo},"${title.replace(/"/g, '""')}",${new Date().toISOString()},ok,${oppLabel},${insttNm},\n`, 'utf8');
    }

    if (items.length < perPage) break;
    page++;
  }

  cheliped([{ cmd: 'close' }]);
  console.log(`\n[완료] 총 ${collected}건 수집, 출력: ${opts.outputDir}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
