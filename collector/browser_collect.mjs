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
function canDownload(oppSeCd, fileOppYn, urtxtYn, dtaRedgLmttEndYmd) {
  const today = fmt(new Date());
  if (urtxtYn === 'N') return [false, '국장급 이상 전용'];
  if (oppSeCd === '3') return [false, '비공개'];
  if (oppSeCd === '5' && (dtaRedgLmttEndYmd || '') > today) return [false, `열람제한(${dtaRedgLmttEndYmd})`];
  if (oppSeCd === '1') return [true, ''];
  if (oppSeCd === '2' && fileOppYn === 'Y') return [true, ''];
  return [false, '부분공개(비공개 파일)'];
}

const OPP_LABELS = { '1': '공개', '2': '부분공개', '3': '비공개', '5': '열람제한' };

// ── Cheliped (--session for persistent Chrome) ──
const SESSION_NAME = 'collector-' + process.pid;

function cheliped(commands) {
  const cmdsJson = JSON.stringify(commands);
  try {
    const result = execFileSync('node', [CLI_PATH, '--session', SESSION_NAME, cmdsJson], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 50 * 1024 * 1024,
      cwd: CWD,
    });
    return JSON.parse(result);
  } catch (e) {
    // execFileSync throws on non-zero exit but stdout may still have valid JSON
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch {}
    }
    console.error('[cheliped]', (e.message || '').slice(0, 200));
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

async function syncToSupabase(doc) {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/documents?on_conflict=prdctn_instt_regist_no`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify(doc),
    });
    if (!res.ok) { console.error(`  [Supabase] ${res.status}`); return null; }
    const data = await res.json();
    return data?.[0]?.id || null;  // return document UUID for files FK
  } catch (e) {
    return null;
  }
}

// ── Main ──
async function main() {
  const opts = parseArgs();
  console.log(`[수집 시작] 키워드='${opts.keyword}' 기간=${opts.startDate}~${opts.endDate} 최대=${opts.maxCount}건`);

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

    console.log(`\n[페이지 ${page}] 접속 + 조회 중... (수집 ${collected}/${opts.maxCount})`);

    // goto + AJAX in single cheliped call to maintain session
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

    const results = cheliped([
      { cmd: 'goto', args: [`${BASE_URL}/othicInfo/infoList/orginlInfoList.do`] },
      { cmd: 'run-js', args: [listJs] },
    ]);

    if (!results?.[0]?.result?.success) {
      console.error('[실패] 사이트 접속 불가');
      break;
    }
    if (page === 1) console.log('[브라우저] 접속 성공');

    const jsResult = results?.[1]?.result?.result;
    let listData = null;
    if (typeof jsResult === 'string') {
      try { listData = JSON.parse(jsResult); } catch {}
    } else {
      listData = jsResult;
    }

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
      const prdnDt = doc.PRDCTN_DT || '';  // 14자리: YYYYMMDDHHmmss
      const pDate = doc.P_DATE || prdnDt.slice(0, 8);  // 8자리: YYYYMMDD
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

      // Fetch detail page for full 분류체계 and 보존기간
      const nstSeCd = regNo.slice(0, 3) || insttSeCd;
      const detailUrl = `${BASE_URL}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`;
      const extractJs = `var ths=document.querySelectorAll("th"); var tds=document.querySelectorAll("td"); var d={}; for(var i=0;i<ths.length&&i<tds.length;i++){d[ths[i].textContent.trim()]=tds[i].textContent.trim();} JSON.stringify(d)`;

      // Navigate to detail + extract DOM meta + poll fileList in ONE cheliped call
      const combinedJs = `
var ths=document.querySelectorAll("th");var tds=document.querySelectorAll("td");
var dom={};for(var i=0;i<ths.length&&i<tds.length;i++){dom[ths[i].textContent.trim()]=tds[i].textContent.trim();}
var vo=null;if(typeof result!=="undefined"&&result.openCateSearchVO){vo=result.openCateSearchVO;}
JSON.stringify({dom:dom,hasVO:!!vo,
  vo:vo?{oppSeCd:vo.oppSeCd,urtxtYn:vo.urtxtYn,nstCd:vo.nstCd,chrgDeptNm:vo.chrgDeptNm,chrgDeptCd:vo.chrgDeptCd,docNo:vo.docNo,infoSj:vo.infoSj,chgrNmpn:vo.chgrNmpn,prcsNstNm:vo.prcsNstNm,nstClNm:vo.nstClNm,prsrvPdCd:vo.prsrvPdCd,prdnDt:vo.prdnDt,dtaRedgLmttEndYmd:vo.dtaRedgLmttEndYmd,
    files:(vo.fileList||[]).map(function(f){return{fileId:f.fileId,fileNm:f.fileNm,fileSeDc:f.fileSeDc,fileByteNum:f.fileByteNum,fileOppYn:f.fileOppYn}})}:null});
      `.replace(/\n/g, ' ');

      // If VO not available on first try, poll with setInterval in same session
      const pollJs = `
var tries=0;var iv=setInterval(function(){tries++;
  if(typeof result!=="undefined"&&result.openCateSearchVO&&result.openCateSearchVO.fileList){
    clearInterval(iv);var vo=result.openCateSearchVO;
    window._voResult=JSON.stringify({ok:true,oppSeCd:vo.oppSeCd,urtxtYn:vo.urtxtYn,nstCd:vo.nstCd,chrgDeptNm:vo.chrgDeptNm,chrgDeptCd:vo.chrgDeptCd,docNo:vo.docNo,infoSj:vo.infoSj,chgrNmpn:vo.chgrNmpn,prcsNstNm:vo.prcsNstNm,nstClNm:vo.nstClNm,prsrvPdCd:vo.prsrvPdCd,prdnDt:vo.prdnDt,dtaRedgLmttEndYmd:vo.dtaRedgLmttEndYmd,
      files:(vo.fileList||[]).map(function(f){return{fileId:f.fileId,fileNm:f.fileNm,fileSeDc:f.fileSeDc,fileByteNum:f.fileByteNum,fileOppYn:f.fileOppYn}})});
  }else if(tries>40){clearInterval(iv);window._voResult=JSON.stringify({ok:false});}
},200);"polling"
      `.replace(/\n/g, ' ');

      const detailResults = cheliped([
        { cmd: 'goto', args: [detailUrl] },
        { cmd: 'wait-for', args: ['td', '5000'] },
        { cmd: 'run-js', args: [combinedJs] },
      ]);

      let fullNstClNm = nstClNm;
      let prsrvPdCd = '';
      let detailDeptNm = deptNm;
      let detailDocNo = docNo;
      let fileList = [];
      let voData = null;

      if (detailResults?.[2]?.result?.result) {
        try {
          const combined = JSON.parse(detailResults[2].result.result);
          // DOM metadata
          const dom = combined.dom || {};
          fullNstClNm = dom['분류체계'] || nstClNm;
          prsrvPdCd = dom['보존기간'] || '';
          if (dom['담당부서명'] && !deptNm) detailDeptNm = dom['담당부서명'];
          if (dom['문서번호'] && !docNo) detailDocNo = dom['문서번호'];
          console.log(`    → 상세: 분류=${fullNstClNm.slice(0,40)}... 보존=${prsrvPdCd}`);

          // VO data (may or may not be available yet)
          if (combined.hasVO && combined.vo) {
            voData = combined.vo;
            fileList = voData.files || [];
            if (voData.docNo) detailDocNo = voData.docNo;
            if (voData.chrgDeptNm) detailDeptNm = voData.chrgDeptNm;
          }
        } catch {}
      }

      // If VO not available, poll in same session (goto already done, page is loaded)
      if (!voData) {
        cheliped([{ cmd: 'run-js', args: [pollJs] }]);
        // Wait for polling to complete
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 1500));
          const pollResult = cheliped([{ cmd: 'run-js', args: ['window._voResult || "waiting"'] }]);
          const pVal = pollResult?.[0]?.result?.result;
          if (typeof pVal === 'string' && pVal !== 'waiting') {
            try {
              voData = JSON.parse(pVal);
              if (voData.ok) {
                fileList = voData.files || [];
                if (voData.docNo) detailDocNo = voData.docNo;
                if (voData.chrgDeptNm) detailDeptNm = voData.chrgDeptNm;
              }
            } catch {}
            break;
          }
        }
      }

      if (fileList.length > 0) {
        console.log(`    → 파일: ${fileList.length}개 (${fileList.map(f => f.fileSeDc + ':' + (f.fileNm || '').slice(0,20)).join(', ')})`);
      }

      // Step C: Write metadata.md with full file info
      let md = `# ${title}\n\n## 메타데이터\n\n| 항목 | 내용 |\n|------|------|\n`;
      md += `| 제목 | ${title} |\n`;
      md += `| 문서번호 | ${detailDocNo} |\n`;
      md += `| 기관명 | ${insttNm} |\n`;
      md += `| 담당부서 | ${detailDeptNm} |\n`;
      md += `| 담당자 | ${chargerNm} |\n`;
      md += `| 생산일자 | ${formatDate(pDate)} |\n`;
      md += `| 보존기간 | ${prsrvPdCd} |\n`;
      md += `| 단위업무 | ${unitJob} |\n`;
      md += `| 공개여부 | ${oppLabel} |\n`;
      md += `| 분류체계 | ${fullNstClNm} |\n`;
      md += `| 원문등록번호 | ${regNo} |\n`;
      md += `| 기관코드 | ${insttCd} |\n`;

      md += `\n## 파일 목록\n\n`;
      if (fileList.length > 0) {
        for (const f of fileList) {
          const [dlOk] = canDownload(voData?.oppSeCd || oppSeCd, f.fileOppYn, voData?.urtxtYn || 'Y', voData?.dtaRedgLmttEndYmd || '');
          md += `- **${f.fileSeDc || '기타'}**: ${f.fileNm} (${formatBytes(Number(f.fileByteNum))}) [${dlOk ? '공개' : '비공개'}]\n`;
        }
      } else if (fileNm) {
        fileNm.split('|').forEach(f => { if (f.trim()) md += `- ${f.trim()}\n`; });
      }
      md += `\n## 원문 링크\n\n${detailUrl}\n`;
      fs.writeFileSync(path.join(folderPath, 'metadata.md'), md, 'utf8');

      // Step D: Download files via 3-step fetch API (all in one cheliped run-js on detail page)
      let downloadCount = 0;
      if (!opts.skipFiles && fileList.length > 0 && voData) {
        for (const f of fileList) {
          const [dlOk, dlReason] = canDownload(voData.oppSeCd, f.fileOppYn, voData.urtxtYn, voData.dtaRedgLmttEndYmd);
          if (!dlOk) {
            console.log(`    → 파일 건너뜀: ${f.fileNm} (${dlReason})`);
            continue;
          }

          const isPdf = (f.fileNm || '').toLowerCase().endsWith('.pdf') ? 'Y' : 'N';
          const esc = s => encodeURIComponent((s || '').replace(/\\/g, '').replace(/"/g, ''));

          // All 3 steps via sync XHR. Step 3 uses overrideMimeType for binary.
          const dlAllJs = `
try{
  var x1=new XMLHttpRequest();x1.open("POST","/util/wonmunUtils/wonmunFileRequest.ajax",false);
  x1.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
  x1.send("fileId=${esc(f.fileId)}&esbFileName=${esc(f.fileNm)}&docId=${esc(voData.docNo)}&ctDate=${voData.prdnDt||prdnDt}&orgCd=${voData.nstCd}&prdnNstRgstNo=${regNo}&oppSeCd=${voData.oppSeCd}&isPdf=${isPdf}&chrgDeptNm=${esc(voData.chrgDeptNm)}");
  var s1=JSON.parse(x1.responseText);
  if(!s1.esbFilePath){JSON.stringify({ok:false,step:1});}
  else{
    var x2=new XMLHttpRequest();x2.open("POST","/util/wonmunUtils/wonmunFileFilter.ajax",false);
    x2.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
    x2.send("prdnNstRgstNo=${regNo}&prdnDt=${voData.prdnDt||prdnDt}&esbFilePath="+encodeURIComponent(s1.esbFilePath)+"&esbFileName="+encodeURIComponent(s1.esbFileName)+"&fileName="+encodeURIComponent(s1.fileName)+"&fileId=${esc(f.fileId)}&orglPrdnNstCd="+(s1.orglPrdnNstCd||"")+"&nstCd=${voData.nstCd}&orgCd=${voData.nstCd}&orgSeCd=${nstSeCd}&infoSj=${esc(voData.infoSj)}&chgrNmpn=${esc(voData.chgrNmpn)}&orgNm=${esc(voData.prcsNstNm)}&chrgDeptCd=${voData.chrgDeptCd||""}&chrgDeptNm=${esc(voData.chrgDeptNm)}&nstClNm=${esc(voData.nstClNm)}&prsrvPdCd=${voData.prsrvPdCd||""}&docId=${esc(voData.docNo)}&isPdf=${isPdf}&step=step2&closegvrnYn="+(s1.orginlFileVO&&s1.orginlFileVO.closegvrnYn||"N")+"&ndnfFiltrRndabtYn=N&mngrTelno="+(s1.mngrTelno||""));
    var s2=JSON.parse(x2.responseText);
    if(!s2.esbFilePath){JSON.stringify({ok:false,step:2});}
    else{
      var x3=new XMLHttpRequest();x3.open("POST","/util/wonmunUtils/wonmunFileDownload.down",false);
      x3.overrideMimeType("text/plain; charset=x-user-defined");
      x3.setRequestHeader("Content-Type","application/x-www-form-urlencoded");
      x3.send("esbFilePath="+encodeURIComponent(s2.esbFilePath)+"&esbFileName="+encodeURIComponent(s2.esbFileName)+"&fileName="+encodeURIComponent(s2.fileName)+"&isPdf="+(s2.isPdf||"${isPdf}")+"&prdnNstRgstNo=${regNo}&prdnDt=${voData.prdnDt||prdnDt}&fileId=${esc(f.fileId)}&gubun="+encodeURIComponent(s2.esbFilePath));
      if(x3.status===200&&x3.responseText.length>0){
        var raw=x3.responseText;var bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++){bytes[i]=raw.charCodeAt(i)&0xff;}
        var bin="";var chk=8192;for(var j=0;j<bytes.length;j+=chk){bin+=String.fromCharCode.apply(null,bytes.subarray(j,Math.min(j+chk,bytes.length)));}
        JSON.stringify({ok:true,size:bytes.length,data:btoa(bin)});
      }else{JSON.stringify({ok:false,step:3,status:x3.status});}
    }
  }
}catch(e){JSON.stringify({ok:false,error:e.message});}
          `.replace(/\n/g, ' ');

          // goto detail page first (re-establish session context), then run download JS
          const dlResult = cheliped([
            { cmd: 'goto', args: [detailUrl] },
            { cmd: 'wait-for', args: ['td', '3000'] },
            { cmd: 'run-js', args: [dlAllJs] },
          ]);
          // dlResult index 2 has the run-js result
          const dlResultEntry = dlResult?.[2] || dlResult?.[0];
          let dlData = null;
          const dlVal = dlResultEntry?.result?.result;
          if (typeof dlVal === 'string') { try { dlData = JSON.parse(dlVal); } catch {} }

          if (dlData?.ok && dlData.data) {
            const fname = sanitize(`${f.fileSeDc || '기타'}_${f.fileNm || 'file'}`, 200);
            fs.writeFileSync(path.join(folderPath, fname), Buffer.from(dlData.data, 'base64'));
            downloadCount++;
            console.log(`    → 다운로드: ${f.fileSeDc}_${f.fileNm} (${formatBytes(dlData.size)})`);
          } else {
            console.log(`    → 다운로드 실패: ${f.fileNm} (step ${dlData?.step || '?'}, ${dlData?.error || ''})`);
          }
        }
      }

      // Step E: Supabase sync - document
      const docId = await syncToSupabase({
        prdctn_instt_regist_no: regNo,
        info_sj: title,
        doc_no: detailDocNo,
        proc_instt_nm: insttNm,
        chrg_dept_nm: detailDeptNm,
        charger_nm: chargerNm,
        prdctn_dt: pDate.length >= 8 ? `${pDate.slice(0,4)}-${pDate.slice(4,6)}-${pDate.slice(6,8)}` : null,
        prdctn_dt_raw: prdnDt || null,
        prsrv_pd_cd: prsrvPdCd || null,
        unit_job_nm: unitJob,
        opp_se_cd: oppSeCd,
        opp_se_nm: oppLabel,
        nst_cl_nm: fullNstClNm,
        instt_cd: insttCd,
        instt_se_cd: insttSeCd,
        status: 'ok',
      });

      // Step F: Supabase sync - files
      if (fileList.length > 0 && supabaseUrl && supabaseKey) {
        for (const f of fileList) {
          const [dlOk] = canDownload(voData?.oppSeCd || oppSeCd, f.fileOppYn, voData?.urtxtYn || 'Y', '');
          try {
            await fetch(`${supabaseUrl}/rest/v1/files`, {
              method: 'POST',
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates',
              },
              body: JSON.stringify({
                document_id: docId || null,
                file_id: f.fileId,
                file_nm: f.fileNm,
                file_se_dc: f.fileSeDc,
                file_byte_num: Number(f.fileByteNum) || null,
                file_opp_yn: f.fileOppYn,
                downloaded: dlOk && downloadCount > 0,
              }),
            });
          } catch {}
        }
      }

      // CSV log
      fs.appendFileSync(csvPath,
        `${collected},${regNo},"${title.replace(/"/g, '""')}",${new Date().toISOString()},ok,${downloadCount},${oppLabel},${insttNm}\n`, 'utf8');
    }

    if (items.length < perPage) break;
    page++;
  }

  cheliped([{ cmd: 'close' }]);
  console.log(`\n[완료] 총 ${collected}건 수집, 출력: ${opts.outputDir}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
