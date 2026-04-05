#!/usr/bin/env node
/**
 * 특정 문서를 직접 수집하는 유틸리티
 * Usage: node collect_specific.mjs <regNo> <prdnDt> <nstSeCd> <outputDir>
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import everything from browser_collect.mjs by running it as a module
// For now, just use the cheliped directly

const CLI_PATH = path.join(__dirname, 'cheliped-browser', 'scripts', 'cheliped-cli.mjs');
const CWD = path.join(__dirname, 'cheliped-browser', 'scripts');
const SESSION = 'specific-' + process.pid;
const BASE = 'https://www.open.go.kr';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

function cheliped(cmds) {
  try {
    const r = execFileSync('node', [CLI_PATH, '--session', SESSION, JSON.stringify(cmds)], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 50*1024*1024, cwd: CWD,
    });
    return JSON.parse(r);
  } catch(e) {
    if (e.stdout) try { return JSON.parse(e.stdout); } catch {}
    return null;
  }
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB']; let i=0,s=b;
  while(s>=1024&&i<u.length-1){s/=1024;i++;}
  return `${s.toFixed(1)} ${u[i]}`;
}
function sanitize(n, l=200) { return n.replace(/[\\/:"*?<>|\[\]「」\r\n&;]/g,'_').slice(0,l).trim()||'untitled'; }
function getFileExt(n) { if(!n)return'';const d=n.lastIndexOf('.');return d>=0?n.slice(d).toLowerCase():''; }

const [regNo, prdnDt, nstSeCd, outDir] = process.argv.slice(2);
if (!regNo) { console.log('Usage: node collect_specific.mjs <regNo> <prdnDt> <nstSeCd> <outputDir>'); process.exit(1); }
const outputDir = outDir || './specific_output';

async function main() {
  console.log(`[수집] regNo=${regNo} prdnDt=${prdnDt} nstSeCd=${nstSeCd}`);
  fs.mkdirSync(outputDir, { recursive: true });

  // Navigate to detail page
  const url = `${BASE}/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=${regNo}&prdnDt=${prdnDt}&nstSeCd=${nstSeCd}&title=%EC%9B%90%EB%AC%B8%EC%A0%95%EB%B3%B4`;

  const extractJs = `var ths=document.querySelectorAll("th");var tds=document.querySelectorAll("td");var d={};for(var i=0;i<ths.length&&i<tds.length;i++){d[ths[i].textContent.trim()]=tds[i].textContent.trim();}JSON.stringify(d)`;

  const r1 = cheliped([
    { cmd: 'goto', args: [url] },
    { cmd: 'wait-for', args: ['td', '5000'] },
    { cmd: 'run-js', args: [extractJs] },
  ]);

  const dom = r1?.[2]?.result?.result ? JSON.parse(r1[2].result.result) : {};
  console.log('[상세] 제목:', dom['제목'] || '(없음)');
  console.log('[상세] 기관:', dom['기관명']);
  console.log('[상세] 보존기간:', dom['보존기간']);
  console.log('[상세] 분류체계:', dom['분류체계']);

  // Get fileList from openCateSearchVO
  const pollJs = `var tries=0;var iv=setInterval(function(){tries++;if(typeof result!=="undefined"&&result.openCateSearchVO&&result.openCateSearchVO.fileList){clearInterval(iv);var vo=result.openCateSearchVO;window._voData=JSON.stringify({ok:true,oppSeCd:vo.oppSeCd,urtxtYn:vo.urtxtYn,nstCd:vo.nstCd,chrgDeptNm:vo.chrgDeptNm,chrgDeptCd:vo.chrgDeptCd,docNo:vo.docNo,infoSj:vo.infoSj,chgrNmpn:vo.chgrNmpn,prcsNstNm:vo.prcsNstNm,nstClNm:vo.nstClNm,prsrvPdCd:vo.prsrvPdCd,prdnDt:vo.prdnDt,dtaRedgLmttEndYmd:vo.dtaRedgLmttEndYmd,files:vo.fileList.map(function(f){return{fileId:f.fileId,fileNm:f.fileNm,fileSeDc:f.fileSeDc,fileByteNum:f.fileByteNum,fileOppYn:f.fileOppYn}})})}else if(tries>40){clearInterval(iv);window._voData=JSON.stringify({ok:false})}},200);"polling"`;
  cheliped([{ cmd: 'run-js', args: [pollJs] }]);

  // Wait and read
  await new Promise(r => setTimeout(r, 5000));
  const voR = cheliped([{ cmd: 'run-js', args: ['window._voData || "waiting"'] }]);
  let voData = null;
  const voVal = voR?.[0]?.result?.result;
  if (typeof voVal === 'string' && voVal !== 'waiting') {
    try { voData = JSON.parse(voVal); } catch {}
  }

  if (!voData?.ok) {
    console.log('[오류] fileList를 가져올 수 없음');
    cheliped([{ cmd: 'close' }]);
    return;
  }

  const fileList = voData.files || [];
  console.log(`[파일] ${fileList.length}개:`, fileList.map(f => `${f.fileSeDc}:${f.fileNm}`).join(', '));

  // Download each downloadable file
  for (const f of fileList) {
    const canDl = voData.oppSeCd === '1' || (voData.oppSeCd === '2' && f.fileOppYn === 'Y');
    if (!canDl || voData.urtxtYn === 'N') {
      console.log(`  → 건너뜀: ${f.fileNm} (비공개)`);
      continue;
    }

    const isPdf = f.fileNm.toLowerCase().endsWith('.pdf') ? 'Y' : 'N';
    const esc = s => encodeURIComponent((s||'').replace(/\\/g,'').replace(/"/g,''));

    const dlJs = `
try{var x1=new XMLHttpRequest();x1.open("POST","/util/wonmunUtils/wonmunFileRequest.ajax",false);x1.setRequestHeader("Content-Type","application/x-www-form-urlencoded");x1.send("fileId=${esc(f.fileId)}&esbFileName=${esc(f.fileNm)}&docId=${esc(voData.docNo)}&ctDate=${voData.prdnDt||prdnDt}&orgCd=${voData.nstCd}&prdnNstRgstNo=${regNo}&oppSeCd=${voData.oppSeCd}&isPdf=${isPdf}&chrgDeptNm=${esc(voData.chrgDeptNm)}");var s1=JSON.parse(x1.responseText);if(!s1.esbFilePath){JSON.stringify({ok:false,step:1});}else{var x2=new XMLHttpRequest();x2.open("POST","/util/wonmunUtils/wonmunFileFilter.ajax",false);x2.setRequestHeader("Content-Type","application/x-www-form-urlencoded");x2.send("prdnNstRgstNo=${regNo}&prdnDt=${voData.prdnDt||prdnDt}&esbFilePath="+encodeURIComponent(s1.esbFilePath)+"&esbFileName="+encodeURIComponent(s1.esbFileName)+"&fileName="+encodeURIComponent(s1.fileName)+"&fileId=${esc(f.fileId)}&orglPrdnNstCd="+(s1.orglPrdnNstCd||"")+"&nstCd=${voData.nstCd}&orgCd=${voData.nstCd}&orgSeCd=${nstSeCd}&infoSj=${esc(voData.infoSj)}&chgrNmpn=${esc(voData.chgrNmpn)}&orgNm=${esc(voData.prcsNstNm)}&chrgDeptCd=${voData.chrgDeptCd||""}&chrgDeptNm=${esc(voData.chrgDeptNm)}&nstClNm=${esc(voData.nstClNm)}&prsrvPdCd=${voData.prsrvPdCd||""}&docId=${esc(voData.docNo)}&isPdf=${isPdf}&step=step2&closegvrnYn="+(s1.orginlFileVO&&s1.orginlFileVO.closegvrnYn||"N")+"&ndnfFiltrRndabtYn=N&mngrTelno="+(s1.mngrTelno||""));var s2=JSON.parse(x2.responseText);if(!s2.esbFilePath){JSON.stringify({ok:false,step:2});}else{var x3=new XMLHttpRequest();x3.open("POST","/util/wonmunUtils/wonmunFileDownload.down",false);x3.overrideMimeType("text/plain; charset=x-user-defined");x3.setRequestHeader("Content-Type","application/x-www-form-urlencoded");x3.send("esbFilePath="+encodeURIComponent(s2.esbFilePath)+"&esbFileName="+encodeURIComponent(s2.esbFileName)+"&fileName="+encodeURIComponent(s2.fileName)+"&isPdf="+(s2.isPdf||"${isPdf}")+"&prdnNstRgstNo=${regNo}&prdnDt=${voData.prdnDt||prdnDt}&fileId=${esc(f.fileId)}&gubun="+encodeURIComponent(s2.esbFilePath));if(x3.status===200&&x3.responseText.length>0){var raw=x3.responseText;var bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++){bytes[i]=raw.charCodeAt(i)&0xff;}var bin="";var chk=8192;for(var j=0;j<bytes.length;j+=chk){bin+=String.fromCharCode.apply(null,bytes.subarray(j,Math.min(j+chk,bytes.length)));}JSON.stringify({ok:true,size:bytes.length,data:btoa(bin)});}else{JSON.stringify({ok:false,step:3,status:x3.status});}}}}catch(e){JSON.stringify({ok:false,error:e.message});}
    `.replace(/\n/g, ' ');

    const dlR = cheliped([
      { cmd: 'goto', args: [url] },
      { cmd: 'wait-for', args: ['td', '3000'] },
      { cmd: 'run-js', args: [dlJs] },
    ]);
    const dlEntry = dlR?.[2] || dlR?.[0];
    let dlData = null;
    const dlVal = dlEntry?.result?.result;
    if (typeof dlVal === 'string') try { dlData = JSON.parse(dlVal); } catch {}

    if (dlData?.ok && dlData.data) {
      const fname = sanitize(`${f.fileSeDc}_${f.fileNm}`);
      const buf = Buffer.from(dlData.data, 'base64');
      fs.writeFileSync(path.join(outputDir, fname), buf);
      console.log(`  → 다운로드: ${fname} (${formatBytes(buf.length)})`);

      // PDF text extraction
      const ext = getFileExt(f.fileNm);
      if (ext === '.pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(buf);
          console.log(`  → PDF 텍스트: ${data.text.length}자`);
          fs.writeFileSync(path.join(outputDir, fname + '_내용.md'),
            `# ${f.fileNm}\n\n## 요약\n\n${data.text.slice(0, 500)}\n\n## 전체 내용\n\n\`\`\`\n${data.text}\n\`\`\`\n`, 'utf8');
        } catch(e) { console.log(`  → PDF 추출 실패: ${e.message}`); }
      }

      // ZIP analysis
      if (ext === '.zip') {
        try {
          // Parse ZIP entries
          let eocdOff = -1;
          for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
            if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06) { eocdOff=i; break; }
          }
          if (eocdOff >= 0) {
            const cdOffset = buf.readUInt32LE(eocdOff + 16);
            const cdCount = buf.readUInt16LE(eocdOff + 10);
            let pos = cdOffset;
            const entries = [];
            for (let e = 0; e < cdCount && pos < buf.length - 46; e++) {
              if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
              const uncompSize = buf.readUInt32LE(pos+24);
              const nameLen = buf.readUInt16LE(pos+28);
              const extraLen = buf.readUInt16LE(pos+30);
              const commentLen = buf.readUInt16LE(pos+32);
              const dosDate = buf.readUInt16LE(pos+14);
              const year = ((dosDate>>9)&0x7f)+1980;
              const month = (dosDate>>5)&0x0f;
              const day = dosDate&0x1f;
              const fileName = buf.slice(pos+46, pos+46+nameLen).toString('utf8');
              entries.push({ path: fileName, size: uncompSize, modified: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` });
              pos += 46 + nameLen + extraLen + commentLen;
            }
            const fileEntries = entries.filter(e => !e.path.endsWith('/'));
            console.log(`  → ZIP 구조: ${fileEntries.length}개 파일`);
            let md = `# ${f.fileNm} 내부 구조\n\n## 파일 목록 (${fileEntries.length}개)\n\n| # | 경로 | 크기 | 수정일 |\n|---|------|------|--------|\n`;
            fileEntries.forEach((e, i) => { md += `| ${i+1} | ${e.path} | ${formatBytes(e.size)} | ${e.modified} |\n`; });
            fs.writeFileSync(path.join(outputDir, fname + '_구조.md'), md, 'utf8');
            fileEntries.forEach(e => console.log(`    ${e.path} (${formatBytes(e.size)})`));
          }
        } catch(e) { console.log(`  → ZIP 분석 실패: ${e.message}`); }
      }
    } else {
      console.log(`  → 다운로드 실패: ${f.fileNm} (step ${dlData?.step||'?'}, ${dlData?.error||''})`);
    }
  }

  cheliped([{ cmd: 'close' }]);
  console.log('\n[완료]');
}

main().catch(e => { console.error(e); process.exit(1); });
