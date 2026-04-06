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
import { createRequire } from 'module';
import { config as dotenvConfig } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env 파일 로드
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').replace(/\r/g, '').split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0 && !line.startsWith('#')) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key && val && !process.env[key]) process.env[key] = val;
      }
    });
  }
} catch {}

const require = createRequire(import.meta.url);
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const claude = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
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
// ── Timing utilities ──
function now() { return Date.now(); }
function elapsed(start) {
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60000)}m${Math.floor((ms%60000)/1000)}s`;
}
function timestamp() { return new Date().toISOString().slice(11, 19); }
function tlog(msg) { console.log(`[${timestamp()}] ${msg}`); }

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

// ── File property extraction ──
function extractFileProperties(buf, fileName) {
  const props = { size_bytes: buf.length };
  const ext = getFileExt(fileName).toLowerCase();

  // JPEG EXIF
  if ((ext === '.jpg' || ext === '.jpeg') && buf[0] === 0xFF && buf[1] === 0xD8) {
    props.mime_type = 'image/jpeg';
    try { Object.assign(props, parseExif(buf)); } catch {}
  }
  // PNG
  else if (ext === '.png' && buf[0] === 0x89 && buf[1] === 0x50) {
    props.mime_type = 'image/png';
    if (buf.length > 24) {
      props.image_width = buf.readUInt32BE(16);
      props.image_height = buf.readUInt32BE(20);
      const bitDepth = buf[24];
      props.bit_depth = bitDepth;
    }
  }
  // GIF
  else if (ext === '.gif' && buf[0] === 0x47) {
    props.mime_type = 'image/gif';
    if (buf.length > 10) {
      props.image_width = buf.readUInt16LE(6);
      props.image_height = buf.readUInt16LE(8);
    }
  }
  // BMP
  else if (ext === '.bmp' && buf[0] === 0x42 && buf[1] === 0x4D) {
    props.mime_type = 'image/bmp';
    if (buf.length > 26) {
      props.image_width = buf.readInt32LE(18);
      props.image_height = Math.abs(buf.readInt32LE(22));
      props.bit_depth = buf.readUInt16LE(28);
    }
  }
  // TIFF (often from scanners)
  else if (ext === '.tif' || ext === '.tiff') {
    props.mime_type = 'image/tiff';
    try { Object.assign(props, parseTiffBasic(buf)); } catch {}
  }
  // PDF
  else if (ext === '.pdf' && buf[0] === 0x25 && buf[1] === 0x50) {
    props.mime_type = 'application/pdf';
    // Extract PDF version
    const header = buf.slice(0, 20).toString('ascii');
    const m = header.match(/PDF-(\d+\.\d+)/);
    if (m) props.pdf_version = m[1];
    // Page count estimation (simple: count /Type /Page)
    const text = buf.toString('ascii', 0, Math.min(buf.length, 500000));
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages > 0) props.page_count = pages;
  }
  // Video formats
  else if (['.mp4', '.avi', '.mov', '.wmv', '.mkv', '.webm'].includes(ext)) {
    props.mime_type = `video/${ext.slice(1)}`;
    if (ext === '.mp4' || ext === '.mov') {
      try { Object.assign(props, parseMp4Basic(buf)); } catch {}
    }
  }
  // HWP
  else if (ext === '.hwp') {
    props.mime_type = 'application/x-hwp';
    if (buf[0] === 0xD0 && buf[1] === 0xCF) props.format = 'OLE2 (HWP binary)';
    else if (buf.slice(0, 4).toString() === 'HWP ') props.format = 'HWP Document';
  }
  // Office formats
  else if (['.xlsx', '.docx', '.pptx'].includes(ext)) {
    props.mime_type = ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (buf[0] === 0x50 && buf[1] === 0x4B) props.format = 'Office Open XML (ZIP-based)';
  }

  return props;
}

// Parse JPEG EXIF for image dimensions, DPI, camera info
function parseExif(buf) {
  const props = {};
  let offset = 2;
  while (offset < buf.length - 4) {
    if (buf[offset] !== 0xFF) break;
    const marker = buf[offset + 1];
    if (marker === 0xDA) break; // Start of scan
    const segLen = buf.readUInt16BE(offset + 2);

    // SOFn markers for dimensions
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)) {
      if (offset + 9 <= buf.length) {
        props.bit_depth = buf[offset + 4];
        props.image_height = buf.readUInt16BE(offset + 5);
        props.image_width = buf.readUInt16BE(offset + 7);
      }
    }
    // APP1 = EXIF
    if (marker === 0xE1 && offset + 10 < buf.length) {
      const exifStr = buf.slice(offset + 4, offset + 8).toString('ascii');
      if (exifStr === 'Exif') {
        try { Object.assign(props, parseExifIFD(buf, offset + 10)); } catch {}
      }
    }
    // JFIF for DPI
    if (marker === 0xE0 && offset + 14 < buf.length) {
      const units = buf[offset + 11];
      const xDpi = buf.readUInt16BE(offset + 12);
      const yDpi = buf.readUInt16BE(offset + 14);
      if (units === 1) { props.dpi_x = xDpi; props.dpi_y = yDpi; }
    }
    offset += 2 + segLen;
  }
  return props;
}

function parseExifIFD(buf, tiffStart) {
  const props = {};
  const le = buf.readUInt16BE(tiffStart) === 0x4949; // little endian
  const r16 = le ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32 = le ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);

  const ifdOffset = r32(tiffStart + 4);
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart + 2 > buf.length) return props;
  const entries = r16(ifdStart);

  for (let i = 0; i < entries && ifdStart + 2 + i * 12 + 12 <= buf.length; i++) {
    const eOff = ifdStart + 2 + i * 12;
    const tag = r16(eOff);
    const type = r16(eOff + 2);
    const valOff = type <= 2 && r32(eOff + 4) <= 4 ? eOff + 8 : tiffStart + r32(eOff + 8);

    const readStr = (off, len) => {
      if (off + len > buf.length) return '';
      return buf.slice(off, off + len).toString('ascii').replace(/\0/g, '').trim();
    };

    switch (tag) {
      case 0x010F: props.camera_make = readStr(valOff, r32(eOff + 4)); break;
      case 0x0110: props.camera_model = readStr(valOff, r32(eOff + 4)); break;
      case 0x0131: props.software = readStr(valOff, r32(eOff + 4)); break;
      case 0x0132: props.date_taken = readStr(valOff, r32(eOff + 4)); break;
      case 0x011A: // X Resolution
        if (valOff + 8 <= buf.length) props.dpi_x = r32(valOff) / (r32(valOff + 4) || 1);
        break;
      case 0x011B: // Y Resolution
        if (valOff + 8 <= buf.length) props.dpi_y = r32(valOff) / (r32(valOff + 4) || 1);
        break;
      case 0xA003: props.image_height_exif = r32(eOff + 8); break;
      case 0xA002: props.image_width_exif = r32(eOff + 8); break;
    }
  }
  return props;
}

function parseTiffBasic(buf) {
  const props = {};
  const le = buf[0] === 0x49;
  const r16 = le ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32 = le ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);
  const ifdOff = r32(4);
  if (ifdOff + 2 > buf.length) return props;
  const entries = r16(ifdOff);
  for (let i = 0; i < entries && ifdOff + 2 + i * 12 + 12 <= buf.length; i++) {
    const e = ifdOff + 2 + i * 12;
    const tag = r16(e);
    if (tag === 0x0100) props.image_width = r32(e + 8);
    if (tag === 0x0101) props.image_height = r32(e + 8);
    if (tag === 0x0102) props.bit_depth = r16(e + 8);
    if (tag === 0x010F) { const off = r32(e + 8); props.scanner_make = buf.slice(off, off + r32(e + 4)).toString('ascii').replace(/\0/g, '').trim(); }
    if (tag === 0x0110) { const off = r32(e + 8); props.scanner_model = buf.slice(off, off + r32(e + 4)).toString('ascii').replace(/\0/g, '').trim(); }
    if (tag === 0x0131) { const off = r32(e + 8); props.software = buf.slice(off, off + r32(e + 4)).toString('ascii').replace(/\0/g, '').trim(); }
    if (tag === 0x011A && r32(e + 8) + 8 <= buf.length) { const off = r32(e + 8); props.dpi_x = r32(off) / (r32(off + 4) || 1); }
    if (tag === 0x011B && r32(e + 8) + 8 <= buf.length) { const off = r32(e + 8); props.dpi_y = r32(off) / (r32(off + 4) || 1); }
  }
  return props;
}

function parseMp4Basic(buf) {
  const props = {};
  let pos = 0;
  while (pos + 8 < buf.length && pos < 100000) {
    const size = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (size < 8) break;
    if (type === 'mvhd' && pos + 28 < buf.length) {
      const timescale = buf.readUInt32BE(pos + 20);
      const duration = buf.readUInt32BE(pos + 24);
      if (timescale > 0) props.duration_seconds = Math.round(duration / timescale);
    }
    if (type === 'tkhd' && pos + 84 < buf.length) {
      props.video_width = buf.readUInt32BE(pos + 76) >> 16;
      props.video_height = buf.readUInt32BE(pos + 80) >> 16;
    }
    // Recurse into container atoms
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
      pos += 8; continue;
    }
    pos += size;
  }
  return props;
}

// ── Text extraction from files ──
async function extractTextContent(buf, fileName) {
  const ext = getFileExt(fileName).toLowerCase();
  try {
    // PDF text extraction (pdf-parse v1)
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf, { max: 100 });
      return data.text || '';
    }
    // XLSX: extract from shared strings in ZIP
    if (ext === '.xlsx' && buf[0] === 0x50 && buf[1] === 0x4B) {
      return extractXlsxText(buf);
    }
    // DOCX: extract from document.xml in ZIP
    if (ext === '.docx' && buf[0] === 0x50 && buf[1] === 0x4B) {
      return extractDocxText(buf);
    }
    // Plain text files
    if (['.txt', '.csv', '.tsv', '.log', '.md', '.json', '.xml', '.html', '.htm'].includes(ext)) {
      return buf.toString('utf8').slice(0, 500000);
    }
  } catch (e) {
    tlog(`    → 텍스트 추출 실패: ${e.message?.slice(0, 80)}`);
  }
  return '';
}

// Extract text from XLSX (Office Open XML) shared strings
function extractXlsxText(buf) {
  const entries = parseZipEntries(buf);
  // Find sharedStrings.xml
  const ssEntry = entries.find(e => e.path.includes('sharedStrings.xml'));
  if (!ssEntry) return '';
  // Extract from ZIP using Central Directory info
  // Simple approach: search for <t> tags in the buffer
  const text = buf.toString('utf8', 0, Math.min(buf.length, 2000000));
  const matches = text.match(/<t[^>]*>([^<]+)<\/t>/g) || [];
  return matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').slice(0, 200000);
}

// Extract text from DOCX (Office Open XML)
function extractDocxText(buf) {
  const text = buf.toString('utf8', 0, Math.min(buf.length, 2000000));
  // Find <w:t> tags in document.xml
  const matches = text.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
  return matches.map(m => m.replace(/<[^>]+>/g, '')).join('').slice(0, 200000);
}

// Generate summary from extracted text
// 6하 원칙 기반 요약 (누가, 누구에게, 언제, 어디서, 무엇을, 왜)
// 공문서 구조화 분석 + 6하 원칙 요약
function generateSummary(text, title, metadata) {
  if (!text || text.trim().length < 10) return '';
  // 줄 단위로 분석 (원본 줄바꿈 보존)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const cleaned = text.replace(/\s+/g, ' ').trim();

  const info = {
    기관명: metadata?.proc_instt_nm || '',
    담당부서: metadata?.chrg_dept_nm || '',
    담당자: metadata?.charger_nm || '',
    생산일자: metadata?.prdctn_dt || '',
  };

  // ── 1. 발신 기관 (상단 기관명) ──
  const orgLine = lines.find(l => /청$|관$|원$|부$|실$|센터$|재단$|위원회$/.test(l) && l.length < 30);
  if (orgLine && !info.기관명) info.기관명 = orgLine;

  // ── 2. 수신처 + 문서 유형 판별 ──
  const rcvLine = lines.find(l => /^수신/.test(l));
  let 수신처 = '';
  let 문서유형 = '';
  if (rcvLine) {
    수신처 = rcvLine.replace(/^수신\s*[:：]?\s*/, '').replace(/\(.*\)/, '').trim();
    if (수신처 === '내부결재' || 수신처 === '') {
      문서유형 = '내부결재';
    } else {
      문서유형 = '외부발송';
    }
  }

  // ── 3. 제목 ──
  const titleLine = lines.find(l => /^제목/.test(l));
  const 제목 = titleLine ? titleLine.replace(/^제목\s*[:：]?\s*/, '').trim() : title;

  // ── 4. 본문 내용 (제목 이후 ~ 결재라인 이전) ──
  const titleIdx = lines.findIndex(l => /^제목/.test(l));
  const signIdx = lines.findIndex(l => /^★|^결재|^주무관/.test(l));
  const contactIdx = lines.findIndex(l => /^시행|^우\d{5}/.test(l));
  const endIdx = signIdx > 0 ? signIdx : (contactIdx > 0 ? contactIdx : lines.length);
  const bodyLines = titleIdx >= 0 ? lines.slice(titleIdx + 1, endIdx) : [];
  const 본문 = bodyLines.filter(l => l.length > 2 && !/^붙임|^끝\.$/.test(l)).join('\n');

  // ── 5. 관련 근거 ──
  const reasonLines = bodyLines.filter(l => /^관련|^\s*가\.\s|^\s*나\.\s/.test(l));
  const 근거 = reasonLines.length > 0 ? reasonLines.join('\n') : '';

  // ── 6. 붙임 목록 ──
  const 붙임 = bodyLines.filter(l => /^붙임/.test(l)).map(l => l.replace(/^붙임\s*/, '').trim()).filter(Boolean);

  // ── 7. 결재라인 ──
  const 결재라인 = [];
  if (signIdx >= 0) {
    let i = signIdx;
    let currentRole = '';
    while (i < lines.length && !/^시행|^우\d{5}/.test(lines[i])) {
      const line = lines[i];
      if (/^★/.test(line)) currentRole = line.replace(/^★\s*/, '');
      else if (/담당$|과장$|국장$|교육장$|교육감$|관장$|장$/.test(line)) currentRole = line;
      else if (currentRole && line.length >= 2 && line.length <= 10 && !/^\d|^시행|^접수|^우/.test(line)) {
        결재라인.push({ 직위: currentRole, 이름: line });
        currentRole = '';
      }
      // "협조자" 이후
      if (line === '협조자') currentRole = '협조자';
      i++;
    }
  }

  // ── 8. 연락처 정보 추출 ──
  const 연락처 = {};
  const addrMatch = cleaned.match(/우(\d{5})\s*([^\n/]+)/);
  if (addrMatch) {
    연락처.우편번호 = addrMatch[1];
    연락처.주소 = addrMatch[2].trim().replace(/(\S)\s{1}(\S{1,3})(?=\s|$)/g, (_, a, b) =>
      /[가-힣]/.test(a) && /[가-힣]/.test(b) ? a + b : _
    );
  }
  const phoneMatch = cleaned.match(/전화\s*([\d-]+)/);
  if (phoneMatch) 연락처.전화 = phoneMatch[1];
  const faxMatch = cleaned.match(/전송\s*([\d-]+)/);
  if (faxMatch) 연락처.팩스 = faxMatch[1];
  const emailMatch = cleaned.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (emailMatch) 연락처.이메일 = emailMatch[1];
  const urlMatch = cleaned.match(/(https?:\/\/[^\s/]+)/);
  if (urlMatch) 연락처.홈페이지 = urlMatch[1];
  const docNoMatch = cleaned.match(/시행\s*([\w-]+\(\))/);
  if (docNoMatch) 연락처.시행문서번호 = docNoMatch[1];

  // ── 요약 구성 (가독성 높게) ──
  let s = '';
  s += `## 문서 개요\n\n`;

  const fmtDate = info.생산일자?.length >= 8
    ? `${info.생산일자.slice(0,4)}.${info.생산일자.slice(4,6)}.${info.생산일자.slice(6,8)}`
    : info.생산일자;

  s += `| 구분 | 내용 |\n|------|------|\n`;
  s += `| 문서유형 | ${문서유형 || '-'} |\n`;
  s += `| 발신기관 | ${info.기관명} ${info.담당부서} |\n`;
  if (수신처 && 문서유형 !== '내부결재') s += `| 수신처 | ${수신처} |\n`;
  s += `| 생산일자 | ${fmtDate} |\n`;
  s += `| 제목 | ${제목} |\n`;

  // 근거
  if (근거) {
    s += `\n## 관련 근거\n\n`;
    근거.split('\n').forEach(l => { s += `- ${l.trim()}\n`; });
  }

  // 핵심 내용
  if (본문) {
    s += `\n## 핵심 내용\n\n`;
    // 번호 매겨진 항목을 구조화
    const items = 본문.split(/(?=\d+\.\s)/).filter(l => l.trim().length > 5);
    if (items.length > 1) {
      items.forEach(item => { s += `- ${item.trim()}\n`; });
    } else {
      s += `${본문.trim()}\n`;
    }
  }

  // 붙임
  if (붙임.length > 0) {
    s += `\n## 붙임\n\n`;
    붙임.forEach((b, i) => { s += `${i + 1}. ${b}\n`; });
  }

  // 결재라인
  if (결재라인.length > 0) {
    s += `\n## 결재라인\n\n`;
    s += `| 직위 | 이름 |\n|------|------|\n`;
    결재라인.forEach(r => { s += `| ${r.직위} | ${r.이름} |\n`; });
  }

  // 연락처
  const 연락처항목 = Object.entries(연락처).filter(([,v]) => v);
  if (연락처항목.length > 0) {
    s += `\n## 연락처\n\n`;
    s += `| 항목 | 내용 |\n|------|------|\n`;
    연락처항목.forEach(([k, v]) => { s += `| ${k} | ${v} |\n`; });
  }

  return s.trim();
}

// Generate content markdown file
function generateContentMd(fileName, text, summary, aiAnalysis) {
  let md = `# ${fileName} 내용\n\n`;

  // AI 분석 결과 (있으면 우선 표시)
  if (aiAnalysis) {
    md += `## AI 문서 분석\n\n`;
    md += `### 문서 목적\n\n${aiAnalysis.purpose || '-'}\n\n`;

    if (aiAnalysis.summary_6w) {
      const w = aiAnalysis.summary_6w;
      md += `### 6하원칙 요약\n\n`;
      md += `| 구분 | 내용 |\n|------|------|\n`;
      md += `| 누가 (Who) | ${w.who || '-'} |\n`;
      md += `| 누구에게 (To Whom) | ${w.to_whom || '-'} |\n`;
      md += `| 언제 (When) | ${w.when || '-'} |\n`;
      md += `| 어디서 (Where) | ${w.where || '-'} |\n`;
      md += `| 무엇을 (What) | ${w.what || '-'} |\n`;
      md += `| 왜 (Why) | ${w.why || '-'} |\n\n`;
    }

    if (aiAnalysis.sender) {
      md += `### 발신/수신\n\n`;
      md += `| 구분 | 기관 | 부서 | 담당자 |\n|------|------|------|--------|\n`;
      md += `| 발신 | ${aiAnalysis.sender.org || '-'} | ${aiAnalysis.sender.dept || '-'} | ${aiAnalysis.sender.person || '-'} |\n`;
      md += `| 수신 | ${aiAnalysis.receiver?.org || '-'} | ${aiAnalysis.receiver?.dept || '-'} | ${aiAnalysis.receiver?.person || '-'} |\n\n`;
    }

    if (aiAnalysis.action_required) {
      md += `### 요청 조치사항\n\n${aiAnalysis.action_required}\n\n`;
    }

    if (aiAnalysis.brm) {
      const b = aiAnalysis.brm;
      md += `### BRM 분류체계\n\n`;
      md += `${b.level1 || ''} > ${b.level2 || ''} > ${b.level3 || ''}${b.level4 ? ' > ' + b.level4 : ''}\n\n`;
    }

    if (aiAnalysis.approval_chain?.length > 0) {
      md += `### 결재라인\n\n`;
      md += `| 직위 | 이름 |\n|------|------|\n`;
      aiAnalysis.approval_chain.forEach(a => { md += `| ${a.role} | ${a.name} |\n`; });
      md += `\n`;
    }
  }

  // 기존 요약 (AI 없을 때 fallback)
  if (summary && !aiAnalysis) {
    md += `## 요약\n\n${summary}\n\n`;
  }

  md += `## 전체 내용\n\n`;
  md += '```\n' + text.slice(0, 100000) + '\n```\n';
  if (text.length > 100000) {
    md += `\n> (총 ${text.length.toLocaleString()}자 중 100,000자까지 표시)\n`;
  }
  return md;
}

// 본문에서 결재라인, 연락처, 문서유형 등 추출
function extractDocExtra(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const extra = {};

  // 문서유형
  const rcvLine = lines.find(l => /^수신/.test(l));
  if (rcvLine) {
    const rcv = rcvLine.replace(/^수신\s*[:：]?\s*/, '').replace(/\(.*\)/, '').trim();
    extra.doc_type = (rcv === '내부결재' || !rcv) ? '내부결재' : '외부발송';
    extra.recipient = rcv || '내부결재';
  }

  // 결재라인
  const signIdx = lines.findIndex(l => /^★/.test(l));
  if (signIdx >= 0) {
    const chain = [];
    let role = '';
    for (let i = signIdx; i < lines.length && !/^시행|^우\d{5}/.test(lines[i]); i++) {
      const l = lines[i];
      if (/^★/.test(l)) role = l.replace(/^★\s*/, '');
      else if (/담당$|과장$|국장$|교육장$|교육감$|관장$|장$|실장$/.test(l)) role = l;
      else if (role && l.length >= 2 && l.length <= 10 && !/^\d|^시행|^접수|^우/.test(l)) {
        chain.push({ role, name: l });
        role = '';
      }
      if (l === '협조자') role = '협조자';
    }
    if (chain.length > 0) extra.approval_chain = chain;
  }

  // 연락처
  const contact = {};
  const m1 = cleaned.match(/우(\d{5})\s*([^/\n]+)/);
  if (m1) {
    contact.zip = m1[1];
    // 주소에서 줄바꿈으로 잘린 단어 복원 (예: "안전수 련원" → "안전수련원")
    contact.address = m1[2].trim()
      .replace(/(\S)\s{1}(\S{1,3})(?=\s|$)/g, (_, a, b) => {
        // 한글 음절 중간에 공백이 들어간 경우 복원
        if (/[가-힣]/.test(a) && /[가-힣]/.test(b)) return a + b;
        return _ ;
      })
      .replace(/\)\s*$/, ')');
  }
  const m2 = cleaned.match(/전화\s*([\d-]+)/);
  if (m2) contact.phone = m2[1];
  const m3 = cleaned.match(/전송\s*([\d-]+)/);
  if (m3) contact.fax = m3[1];
  const m4 = cleaned.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (m4) contact.email = m4[1];
  const m5 = cleaned.match(/(https?:\/\/[^\s/]+)/);
  if (m5) contact.url = m5[1];
  if (Object.keys(contact).length > 0) extra.contact_info = contact;

  return extra;
}

// ── Claude API 문서 분석 ──
async function analyzeWithClaude(text, metadata) {
  if (!claude || !text || text.length < 20) return null;
  try {
    const prompt = `당신은 대한민국 공공기관 공문서 분석 전문가입니다. 아래 공문서를 분석하여 JSON으로 응답하세요.

## 문서 메타데이터
- 제목: ${metadata.info_sj || ''}
- 기관명: ${metadata.proc_instt_nm || ''}
- 담당부서: ${metadata.chrg_dept_nm || ''}
- 담당자: ${metadata.charger_nm || ''}
- 생산일자: ${metadata.prdctn_dt || ''}

## 문서 본문
${text.slice(0, 3000)}

## 분석 규칙

1. **수신처 분석**: "수신내부결재"이면 doc_type="내부결재"이고, 이 경우 receiver에는 결재라인의 최종결재자(가장 높은 직급)의 직위와 이름을 명시하세요.
2. **결재라인**: 본문 하단의 ★주무관 이후 나오는 직위-이름 쌍을 순서대로 추출하세요. "협조자" 이후 나오는 이름도 포함하세요.
3. **6하원칙의 누구에게(to_whom)**: 내부결재인 경우 "내부결재권자 (직위1 이름1, 직위2 이름2, 최종결재직위 최종이름)" 형식으로 결재자 전원의 직위와 이름을 표시하세요.
4. **one_line_summary**: 6하원칙 전체를 하나의 자연스러운 한국어 문장으로 요약하세요. 예: "충청남도교육청 안전수련원 총무부 주무관 이중목이 원장 류동훈에게, 신규 소집 사회복무요원 김태윤의 근무복 구입비 309,000원 지급을 요청하는 내부결재 문서이다."
5. **주소**: 본문에서 우편번호(5자리) 뒤에 나오는 주소를 추출할 때, 줄바꿈으로 잘린 단어는 붙여쓰세요. 숫자 뒤에 바로 기관명이 이어지면 공백을 추가하세요 (예: "88-42충청남도" → "88-42 충청남도").

## JSON 형식 (JSON만 출력)

{
  "sender": {
    "org": "발신 기관명 (상위기관 포함 전체명)",
    "dept": "발신 부서명",
    "person": "담당자명",
    "role": "직위/직급"
  },
  "receiver": {
    "org": "수신 기관명 (내부결재면 발신기관과 동일)",
    "dept": "수신 부서명",
    "person": "최종결재자 이름 (내부결재면 결재라인의 최고직급자)",
    "role": "최종결재자 직위"
  },
  "doc_type": "내부결재 또는 외부발송",
  "summary_6w": {
    "who": "누가 (발신 기관+부서+직위+이름)",
    "to_whom": "누구에게 (내부결재: '내부결재권자 (직위1 이름1, 직위2 이름2, ...)' / 외부: 수신기관+부서)",
    "when": "언제 (날짜)",
    "where": "어디서 (관련 장소/기관)",
    "what": "무엇을 (핵심 행위/요청사항, 구체적 금액/수량 포함, 2~3문장)",
    "why": "왜 (목적/배경/근거, 1~2문장)"
  },
  "one_line_summary": "6하원칙을 자연스러운 한 문장으로 요약 (누가 누구에게 무엇을 왜 하는지)",
  "purpose": "이 문서의 핵심 목적 한 문장",
  "action_required": "요청된 조치사항",
  "brm": {
    "level1": "정책 대분류",
    "level2": "중분류",
    "level3": "소분류",
    "level4": "세분류"
  },
  "approval_chain": [{"role": "직위", "name": "이름"}],
  "contact": {
    "zip": "우편번호 5자리",
    "address": "주소 (줄바꿈 복원, 숫자-기관명 사이 공백 추가)",
    "phone": "전화번호",
    "fax": "팩스번호",
    "email": "이메일",
    "url": "홈페이지 URL"
  }
}`;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0]?.text || '';
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    tlog(`    → Claude 분석 실패: ${e.message?.slice(0, 80)}`);
  }
  return null;
}

// Upload file to Supabase Storage and return public URL
async function uploadToStorage(buf, storagePath) {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/documents/${storagePath}`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buf,
    });
    if (res.ok) {
      return `${supabaseUrl}/storage/v1/object/public/documents/${storagePath}`;
    }
  } catch {}
  return null;
}
const ARCHIVE_EXTS = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'];

function getFileExt(name) {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isArchiveFile(name) {
  return ARCHIVE_EXTS.some(ext => (name || '').toLowerCase().endsWith(ext));
}

// Parse ZIP central directory from Buffer to extract file entries
function parseZipEntries(buf) {
  const entries = [];
  try {
    // Find End of Central Directory (EOCD) signature: 0x06054b50
    let eocdOff = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
      if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
        eocdOff = i; break;
      }
    }
    if (eocdOff < 0) return entries;

    const cdOffset = buf.readUInt32LE(eocdOff + 16);
    const cdEntries = buf.readUInt16LE(eocdOff + 10);
    let pos = cdOffset;

    for (let e = 0; e < cdEntries && pos < buf.length - 46; e++) {
      // Central Directory signature: 0x02014b50
      if (buf[pos] !== 0x50 || buf[pos+1] !== 0x4b || buf[pos+2] !== 0x01 || buf[pos+3] !== 0x02) break;
      const compSize = buf.readUInt32LE(pos + 20);
      const uncompSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      // DOS date/time
      const dosTime = buf.readUInt16LE(pos + 12);
      const dosDate = buf.readUInt16LE(pos + 14);
      const year = ((dosDate >> 9) & 0x7f) + 1980;
      const month = ((dosDate >> 5) & 0x0f);
      const day = dosDate & 0x1f;
      const modified = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

      const fileName = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
      entries.push({ path: fileName, size: uncompSize, compressed: compSize, modified });
      pos += 46 + nameLen + extraLen + commentLen;
    }
  } catch {}
  return entries;
}

// Generate tree structure from zip entries
function buildFileTree(entries, zipName) {
  const dirs = new Map(); // path -> { files: [], subdirs: Set }
  dirs.set('', { files: [], subdirs: new Set() });

  for (const e of entries) {
    if (e.path.endsWith('/')) {
      // Directory entry
      dirs.set(e.path, dirs.get(e.path) || { files: [], subdirs: new Set() });
      const parent = e.path.slice(0, e.path.slice(0, -1).lastIndexOf('/') + 1);
      if (!dirs.has(parent)) dirs.set(parent, { files: [], subdirs: new Set() });
      dirs.get(parent).subdirs.add(e.path);
    } else {
      const lastSlash = e.path.lastIndexOf('/');
      const parent = lastSlash >= 0 ? e.path.slice(0, lastSlash + 1) : '';
      if (!dirs.has(parent)) dirs.set(parent, { files: [], subdirs: new Set() });
      dirs.get(parent).files.push(e);
    }
  }

  function renderTree(dirPath, prefix) {
    const dir = dirs.get(dirPath);
    if (!dir) return '';
    let out = '';
    const items = [
      ...Array.from(dir.subdirs).sort().map(d => ({ type: 'dir', path: d })),
      ...dir.files.sort((a, b) => a.path.localeCompare(b.path)).map(f => ({ type: 'file', ...f })),
    ];
    items.forEach((item, i) => {
      const isLast = i === items.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      if (item.type === 'dir') {
        const name = item.path.slice(dirPath.length).replace(/\/$/, '') + '/';
        out += `${prefix}${connector}${name}\n`;
        out += renderTree(item.path, prefix + childPrefix);
      } else {
        const name = item.path.slice(dirPath.length);
        out += `${prefix}${connector}${name} (${formatBytes(item.size)})\n`;
      }
    });
    return out;
  }

  let tree = `${zipName}\n`;
  tree += renderTree('', '');
  return tree;
}

function generateZipStructureMd(zipName, entries) {
  const fileEntries = entries.filter(e => !e.path.endsWith('/'));
  let md = `# ${zipName} 내부 구조\n\n`;
  md += `## 파일 트리\n\n\`\`\`\n${buildFileTree(entries, zipName)}\`\`\`\n\n`;
  md += `## 파일 목록 (${fileEntries.length}개)\n\n`;
  md += `| # | 경로 | 크기 | 수정일 |\n|---|------|------|--------|\n`;
  fileEntries.forEach((e, i) => {
    md += `| ${i + 1} | ${e.path} | ${formatBytes(e.size)} | ${e.modified} |\n`;
  });
  return md;
}

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
  const totalStart = now();
  tlog(`[수집 시작] 키워드='${opts.keyword}' 기간=${opts.startDate}~${opts.endDate} 최대=${opts.maxCount}건`);

  // Prepare output
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const csvPath = path.join(opts.outputDir, 'collection_log.csv');
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, '번호,원문등록번호,제목,처리시각,상태,다운로드,공개구분,기관명,소요시간,비고\n', 'utf8');
  }

  // Paginate and collect
  let collected = 0;
  let page = 1;
  const perPage = 50;

  while (collected < opts.maxCount) {
    const remaining = opts.maxCount - collected;

    const pageStart = now();
    tlog(`\n[페이지 ${page}] 접속 + 조회 중... (수집 ${collected}/${opts.maxCount})`);

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
    if (page === 1) tlog(`[브라우저] 접속 성공 (${elapsed(pageStart)})`);

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
      tlog(`[목록] 전체 ${totalFound}건 발견 (${elapsed(pageStart)})`);
    }

    if (items.length === 0) {
      tlog('[완료] 더 이상 결과 없음');
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
      const keywords = (doc.tma_kwd || '').replace(/\n/g, ', ').trim();
      const fullDeptNm = htmlDecode(doc.NFLST_CHRG_DEPT_NM || '');

      const folderName = `${collected}_${sanitize(title)}`;
      const folderPath = path.join(opts.outputDir, folderName);

      const docStart = now();
      tlog(`  [${collected}] ${title.slice(0, 55)} (${insttNm})`);

      // Resume
      if (fs.existsSync(folderPath)) {
        tlog('    → 건너뜀 (이미 존재)');
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
          tlog(`    → 상세: 분류=${fullNstClNm.slice(0,40)}... 보존=${prsrvPdCd} (${elapsed(docStart)})`);

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
        tlog(`    → 파일: ${fileList.length}개 (${fileList.map(f => f.fileSeDc + ':' + (f.fileNm || '').slice(0,20)).join(', ')}) (${elapsed(docStart)})`);
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
      if (fullDeptNm) md += `| 소속 전체명 | ${fullDeptNm} |\n`;
      if (keywords) md += `| 키워드 | ${keywords} |\n`;

      md += `\n## 파일 목록 (${fileList.length}개)\n\n`;
      if (fileList.length > 0) {
        fileList.forEach((f, idx) => {
          const ext = getFileExt(f.fileNm);
          const [dlOk] = canDownload(voData?.oppSeCd || oppSeCd, f.fileOppYn, voData?.urtxtYn || 'Y', voData?.dtaRedgLmttEndYmd || '');
          md += `### ${idx + 1}. ${f.fileSeDc || '기타'}: ${f.fileNm}\n\n`;
          md += `| 속성 | 값 |\n|------|------|\n`;
          md += `| 파일ID | ${f.fileId} |\n`;
          md += `| 파일명 | ${f.fileNm} |\n`;
          md += `| 구분 | ${f.fileSeDc || '-'} |\n`;
          md += `| 크기 | ${formatBytes(Number(f.fileByteNum))} (${Number(f.fileByteNum).toLocaleString()} bytes) |\n`;
          md += `| 확장자 | ${ext || '-'} |\n`;
          md += `| 공개여부 | ${dlOk ? '공개' : '비공개'} (fileOppYn=${f.fileOppYn}) |\n`;
          md += `| 압축파일 | ${isArchiveFile(f.fileNm) ? '예' : '아니오'} |\n\n`;
        });
      } else if (fileNm) {
        fileNm.split('|').forEach(f => { if (f.trim()) md += `- ${f.trim()}\n`; });
      }
      md += `\n## 원문 링크\n\n${detailUrl}\n`;
      // metadata.md is written after downloads to include download status
      // (see below after Step D)

      // Step D: Download files via 3-step fetch API (all in one cheliped run-js on detail page)
      let downloadCount = 0;
      if (!opts.skipFiles && fileList.length > 0 && voData) {
        for (const f of fileList) {
          const [dlOk, dlReason] = canDownload(voData.oppSeCd, f.fileOppYn, voData.urtxtYn, voData.dtaRedgLmttEndYmd);
          if (!dlOk) {
            tlog(`    → 파일 건너뜀: ${f.fileNm} (${dlReason})`);
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
            const fileBuf = Buffer.from(dlData.data, 'base64');
            fs.writeFileSync(path.join(folderPath, fname), fileBuf);
            downloadCount++;
            f._downloaded = true;
            f._fileBase64 = dlData.data; // base64 원본 보존 (DB 저장용)
            tlog(`    → 다운로드: ${f.fileSeDc}_${f.fileNm} (${formatBytes(dlData.size)}) (${elapsed(docStart)})`);

            // 파일 속성 추출
            f._properties = extractFileProperties(fileBuf, f.fileNm);
            if (Object.keys(f._properties).length > 1) {
              tlog(`    → 속성: ${Object.keys(f._properties).filter(k => k !== 'size_bytes' && k !== 'mime_type').join(', ')}`);
            }

            // 텍스트 내용 추출
            const textContent = await extractTextContent(fileBuf, f.fileNm);
            if (textContent && textContent.trim().length > 0) {
              f._content = textContent.trim();
              const summaryMeta = { proc_instt_nm: insttNm, chrg_dept_nm: detailDeptNm, charger_nm: chargerNm, prdctn_dt: pDate, info_sj: title };
              f._summary = generateSummary(f._content, title, summaryMeta);

              // 본문(결재문서)에서 추가 메타데이터 추출 → 문서 레코드에 저장
              if (f.fileSeDc === '본문') {
                f._docExtra = extractDocExtra(f._content);

                // Claude API로 심층 분석
                if (claude) {
                  tlog(`    → Claude API 분석 중...`);
                  const aiResult = await analyzeWithClaude(f._content, {
                    info_sj: title, proc_instt_nm: insttNm,
                    chrg_dept_nm: detailDeptNm, charger_nm: chargerNm, prdctn_dt: pDate,
                  });
                  if (aiResult) {
                    f._aiAnalysis = aiResult;
                    tlog(`    → Claude 분석 완료: ${aiResult.purpose?.slice(0, 50) || ''} (${elapsed(docStart)})`);
                  }
                }
              }

              // MD 파일로 저장 (AI 분석 결과 포함)
              const contentMd = generateContentMd(f.fileNm, f._content, f._summary, f._aiAnalysis);
              const contentFname = sanitize(`${f.fileSeDc || '기타'}_${f.fileNm}_내용`, 200) + '.md';
              fs.writeFileSync(path.join(folderPath, contentFname), contentMd, 'utf8');
              tlog(`    → 내용: ${f._content.length.toLocaleString()}자 추출 (${elapsed(docStart)})`);
            }

            // Supabase Storage 업로드
            const storagePath = `${regNo}/${fname}`;
            f._downloadUrl = await uploadToStorage(fileBuf, storagePath);
            if (f._downloadUrl) {
              tlog(`    → Storage: 업로드 완료`);
            }

            // ZIP 파일 구조 분석
            if (isArchiveFile(f.fileNm) && f.fileNm.toLowerCase().endsWith('.zip')) {
              try {
                const zipEntries = parseZipEntries(fileBuf);
                if (zipEntries.length > 0) {
                  f._archiveEntries = zipEntries;
                  const structMd = generateZipStructureMd(f.fileNm, zipEntries);
                  const structFname = sanitize(`${f.fileSeDc || '기타'}_${f.fileNm}_구조`, 200) + '.md';
                  fs.writeFileSync(path.join(folderPath, structFname), structMd, 'utf8');
                  tlog(`    → ZIP 구조: ${zipEntries.filter(e => !e.path.endsWith('/')).length}개 파일 분석`);
                }
              } catch (ze) {
                tlog(`    → ZIP 분석 실패: ${ze.message}`);
              }
            }
          } else {
            f._downloaded = false;
            tlog(`    → 다운로드 실패: ${f.fileNm} (step ${dlData?.step || '?'}, ${dlData?.error || ''})`);
          }
        }
      }

      // Update metadata.md with download status
      if (fileList.length > 0) {
        // Rebuild file section with download results
        let fileMd = `\n## 파일 목록 (${fileList.length}개)\n\n`;
        fileList.forEach((f, idx) => {
          const ext = getFileExt(f.fileNm);
          const [dlOk] = canDownload(voData?.oppSeCd || oppSeCd, f.fileOppYn, voData?.urtxtYn || 'Y', voData?.dtaRedgLmttEndYmd || '');
          fileMd += `### ${idx + 1}. ${f.fileSeDc || '기타'}: ${f.fileNm}\n\n`;
          fileMd += `| 속성 | 값 |\n|------|------|\n`;
          fileMd += `| 파일ID | ${f.fileId} |\n`;
          fileMd += `| 파일명 | ${f.fileNm} |\n`;
          fileMd += `| 구분 | ${f.fileSeDc || '-'} |\n`;
          fileMd += `| 크기 | ${formatBytes(Number(f.fileByteNum))} (${Number(f.fileByteNum).toLocaleString()} bytes) |\n`;
          fileMd += `| 확장자 | ${ext || '-'} |\n`;
          fileMd += `| 공개여부 | ${dlOk ? '공개' : '비공개'} (fileOppYn=${f.fileOppYn}) |\n`;
          fileMd += `| 압축파일 | ${isArchiveFile(f.fileNm) ? '예' : '아니오'} |\n`;
          fileMd += `| 다운로드 | ${f._downloaded ? '완료' : (dlOk ? '실패' : '건너뜀')} |\n`;
          if (f._downloadUrl) {
            fileMd += `| 다운로드 링크 | [다운로드](${f._downloadUrl}) |\n`;
          }
          if (f._archiveEntries) {
            const fileCount = f._archiveEntries.filter(e => !e.path.endsWith('/')).length;
            fileMd += `| ZIP 내부 파일 수 | ${fileCount}개 |\n`;
          }
          // 파일 상세 속성
          if (f._properties) {
            const p = f._properties;
            if (p.mime_type) fileMd += `| MIME 타입 | ${p.mime_type} |\n`;
            if (p.pdf_version) fileMd += `| PDF 버전 | ${p.pdf_version} |\n`;
            if (p.page_count) fileMd += `| 페이지 수 | ${p.page_count} |\n`;
            if (p.image_width) fileMd += `| 이미지 너비 | ${p.image_width}px |\n`;
            if (p.image_height) fileMd += `| 이미지 높이 | ${p.image_height}px |\n`;
            if (p.dpi_x) fileMd += `| 수평 해상도 | ${p.dpi_x} DPI |\n`;
            if (p.dpi_y) fileMd += `| 수직 해상도 | ${p.dpi_y} DPI |\n`;
            if (p.bit_depth) fileMd += `| 비트 수준 | ${p.bit_depth}bit |\n`;
            if (p.camera_make) fileMd += `| 카메라 제조사 | ${p.camera_make} |\n`;
            if (p.camera_model) fileMd += `| 카메라 모델 | ${p.camera_model} |\n`;
            if (p.scanner_make) fileMd += `| 스캐너 제조사 | ${p.scanner_make} |\n`;
            if (p.scanner_model) fileMd += `| 스캐너 모델 | ${p.scanner_model} |\n`;
            if (p.software) fileMd += `| 소프트웨어 | ${p.software} |\n`;
            if (p.date_taken) fileMd += `| 촬영일 | ${p.date_taken} |\n`;
            if (p.format) fileMd += `| 포맷 | ${p.format} |\n`;
            if (p.duration_seconds) fileMd += `| 영상 길이 | ${p.duration_seconds}초 |\n`;
            if (p.video_width) fileMd += `| 영상 너비 | ${p.video_width}px |\n`;
            if (p.video_height) fileMd += `| 영상 높이 | ${p.video_height}px |\n`;
          }
          fileMd += `\n`;
        });
        // 파일 내용 요약 섹션
        const contentFiles = fileList.filter(f => f._summary);
        if (contentFiles.length > 0) {
          fileMd += `\n## 파일 내용 요약\n\n`;
          contentFiles.forEach((f, idx) => {
            fileMd += `### ${f.fileSeDc}: ${f.fileNm}\n\n`;
            fileMd += `> ${f._summary}\n\n`;
            if (f._content) {
              fileMd += `<details><summary>전체 내용 (${f._content.length.toLocaleString()}자)</summary>\n\n`;
              fileMd += '```\n' + f._content.slice(0, 5000) + '\n```\n';
              if (f._content.length > 5000) fileMd += `\n... (${f._content.length.toLocaleString()}자 중 5,000자 표시)\n`;
              fileMd += `\n</details>\n\n`;
            }
          });
        }

        // Rewrite metadata.md with updated file section
        const mdParts = md.split('\n## 파일 목록');
        md = mdParts[0] + fileMd + `\n## 원문 링크\n\n${detailUrl}\n`;
      }
      fs.writeFileSync(path.join(folderPath, 'metadata.md'), md, 'utf8');

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
        // 본문에서 추출한 추가 메타데이터
        ...((() => {
          const bodyFile = fileList.find(f => f.fileSeDc === '본문' && f._docExtra);
          if (!bodyFile?._docExtra) return {};
          const ex = bodyFile._docExtra;
          return {
            doc_type: ex.doc_type || null,
            recipient: ex.recipient || null,
            approval_chain: ex.approval_chain ? JSON.stringify(ex.approval_chain) : null,
            contact_info: ex.contact_info ? JSON.stringify(ex.contact_info) : null,
          };
        })()),
        // 추가 메타데이터
        keywords: keywords || null,
        full_dept_nm: fullDeptNm || null,
        file_count: fileList.length,
        downloaded_count: downloadCount,
        body_summary: (fileList.find(f => f.fileSeDc === '본문' && f._summary) || {})?._summary || null,
        original_url: detailUrl,
        // AI 분석 결과
        ...((() => {
          const bodyFile = fileList.find(f => f.fileSeDc === '본문' && f._aiAnalysis);
          if (!bodyFile?._aiAnalysis) return {};
          const ai = bodyFile._aiAnalysis;
          return {
            sender_info: ai.sender ? JSON.stringify(ai.sender) : null,
            receiver_info: ai.receiver ? JSON.stringify(ai.receiver) : null,
            ai_summary: ai.summary_6w ? JSON.stringify(ai.summary_6w) : null,
            six_w_analysis: ai.summary_6w ? JSON.stringify(ai.summary_6w) : null,
            one_line_summary: ai.one_line_summary || null,
            core_content: [ai.purpose, ai.action_required, ai.summary_6w?.what].filter(Boolean).join('\n\n') || null,
            brm_category: ai.brm ? JSON.stringify(ai.brm) : null,
            ...(ai.doc_type ? { doc_type: ai.doc_type } : {}),
            // 수신처: 내부결재면 최종결재자 포함
            ...(ai.receiver ? {
              recipient: ai.doc_type === '내부결재'
                ? `${ai.receiver.role || ''} ${ai.receiver.person || ''}`.trim() + (ai.receiver.org ? ` (${ai.receiver.org})` : '')
                : (ai.receiver.org || '') + (ai.receiver.dept ? ' ' + ai.receiver.dept : '')
            } : {}),
            ...(ai.approval_chain?.length > 0 ? { approval_chain: JSON.stringify(ai.approval_chain) } : {}),
            // AI가 추출한 연락처가 더 정확하면 사용
            ...(ai.contact ? { contact_info: JSON.stringify(ai.contact) } : {}),
          };
        })()),
      });

      // Step F: Supabase sync - files
      if (fileList.length > 0 && supabaseUrl && supabaseKey) {
        for (const f of fileList) {
          const [dlOk] = canDownload(voData?.oppSeCd || oppSeCd, f.fileOppYn, voData?.urtxtYn || 'Y', '');
          try {
            await fetch(`${supabaseUrl}/rest/v1/files?on_conflict=file_id`, {
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
                downloaded: !!f._downloaded,
                file_ext: getFileExt(f.fileNm) || null,
                is_archive: isArchiveFile(f.fileNm),
                archive_entries: f._archiveEntries ? JSON.stringify(f._archiveEntries) : null,
                file_properties: f._properties ? JSON.stringify(f._properties) : null,
                download_url: f._downloaded ? `/api/download/${f.fileId}` : null,
                file_data: f._fileBase64 || null,
                content: f._content ? f._content.slice(0, 100000) : null,
                summary: f._summary || null,
                content_length: f._content ? f._content.length : null,
              }),
            });
          } catch {}
        }
      }

      // CSV log with timing
      const docElapsed = elapsed(docStart);
      tlog(`    → 문서 완료 (파일 ${downloadCount}개, ${docElapsed})`);
      fs.appendFileSync(csvPath,
        `${collected},${regNo},"${title.replace(/"/g, '""')}",${new Date().toISOString()},ok,${downloadCount},${oppLabel},${insttNm},${docElapsed},\n`, 'utf8');
    }

    if (items.length < perPage) break;
    page++;
  }

  cheliped([{ cmd: 'close' }]);
  tlog(`\n[완료] 총 ${collected}건 수집, 총 소요시간: ${elapsed(totalStart)}, 출력: ${opts.outputDir}`);
}

main().catch(e => { console.error('[오류]', e); process.exit(1); });
