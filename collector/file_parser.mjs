/**
 * 통합 파일 텍스트 추출 모듈
 *
 * 지원 형식:
 * - PDF → pdf-parse
 * - HWPX → adm-zip + XML 추출 (ZIP 기반)
 * - HWP → hwp.js
 * - XLSX, DOCX, PPTX, HTML, CSV 등 → markitdown (Python)
 */
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

let pdfParse, AdmZip;
try { pdfParse = require('pdf-parse'); } catch {}
try { AdmZip = require('adm-zip'); } catch {}

let hwp5txtAvailable = null;
function checkHwp5txt() {
  if (hwp5txtAvailable !== null) return hwp5txtAvailable;
  try {
    execFileSync('hwp5txt', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    hwp5txtAvailable = true;
  } catch { hwp5txtAvailable = false; }
  return hwp5txtAvailable;
}

function getExt(name) {
  if (!name) return '';
  const d = name.lastIndexOf('.');
  return d >= 0 ? name.slice(d).toLowerCase() : '';
}

// HWPX 파서: ZIP 내부 Contents/section*.xml 에서 텍스트 추출
function parseHwpx(buf) {
  if (!AdmZip) return '';
  try {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    let text = '';
    for (const e of entries) {
      if (!e.entryName.match(/Contents\/(section|header).*\.xml$/i)) continue;
      const xml = e.getData().toString('utf8');
      // <hp:t> 또는 <hp:char> 등의 텍스트 추출
      // 간단히: 모든 > ... < 사이 텍스트만 추출
      const matches = xml.match(/>([^<>]+)</g) || [];
      for (const m of matches) {
        const t = m.slice(1, -1).trim();
        if (t && t.length > 0 && !/^[\d\s]+$/.test(t)) {
          text += t + '\n';
        }
      }
    }
    return text.trim();
  } catch { return ''; }
}

// HWP 파서: pyhwp (hwp5txt)
function parseHwp(buf) {
  if (!checkHwp5txt()) return '';
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `hwp_${process.pid}_${Date.now()}.hwp`);
  const outFile = path.join(tmpDir, `hwp_${process.pid}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpFile, buf);
    execFileSync('hwp5txt', ['--output', outFile, tmpFile], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'ignore', 'ignore']
    });
    if (fs.existsSync(outFile)) {
      return fs.readFileSync(outFile, 'utf8').trim();
    }
    return '';
  } catch { return ''; }
  finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

// Markitdown: Python 서브프로세스
let markitdownAvailable = null;
function checkMarkitdown() {
  if (markitdownAvailable !== null) return markitdownAvailable;
  try {
    execFileSync('python', ['-c', 'from markitdown import MarkItDown'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
    markitdownAvailable = true;
  } catch { markitdownAvailable = false; }
  return markitdownAvailable;
}

function parseMarkitdown(buf, ext) {
  if (!checkMarkitdown()) return '';
  // 임시 파일로 저장 후 Python 호출
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `md_${process.pid}_${Date.now()}${ext}`);
  const outFile = path.join(tmpDir, `md_${process.pid}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpFile, buf);
    // outFile로 쓰면 인코딩 문제 없음
    execFileSync('python', ['-c', `
import sys, warnings, io
warnings.filterwarnings('ignore')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from markitdown import MarkItDown
md = MarkItDown()
try:
  r = md.convert(r'${tmpFile}')
  with open(r'${outFile}', 'w', encoding='utf-8') as f:
    f.write(r.text_content)
except Exception as e:
  sys.exit(0)
`], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'ignore', 'ignore'] });
    if (fs.existsSync(outFile)) {
      return fs.readFileSync(outFile, 'utf8').trim();
    }
    return '';
  } catch { return ''; }
  finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * 파일 버퍼에서 텍스트 추출
 * @param {Buffer} buf - 파일 내용
 * @param {string} fileName - 파일명 (확장자 감지용)
 * @returns {Promise<string>} 추출된 텍스트 (실패 시 빈 문자열)
 */
export async function extractText(buf, fileName) {
  if (!buf || buf.length === 0) return '';
  const ext = getExt(fileName);

  // PDF
  if (ext === '.pdf') {
    if (!pdfParse) return '';
    try {
      const pd = await pdfParse(buf);
      return pd.text || '';
    } catch { return ''; }
  }

  // HWPX (ZIP + XML)
  if (ext === '.hwpx') {
    return parseHwpx(buf);
  }

  // HWP (binary, hwp.js)
  if (ext === '.hwp') {
    return parseHwp(buf);
  }

  // Markitdown 지원 형식
  const markitdownExts = ['.xlsx', '.xlsm', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.html', '.htm', '.csv', '.xml', '.json'];
  if (markitdownExts.includes(ext)) {
    return parseMarkitdown(buf, ext);
  }

  return '';
}

export function supportedExtensions() {
  return ['.pdf', '.hwpx', '.hwp', '.xlsx', '.xlsm', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.html', '.htm', '.csv', '.xml', '.json'];
}
