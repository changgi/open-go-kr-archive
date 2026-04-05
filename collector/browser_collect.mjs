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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

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
    console.log(`    → 텍스트 추출 실패: ${e.message?.slice(0, 80)}`);
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
function generateSummary(text, title) {
  if (!text || text.trim().length < 10) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Take first 3 meaningful sentences or 500 chars
  const sentences = cleaned.split(/[.。!?]\s+/).filter(s => s.length > 10);
  const summary = sentences.slice(0, 5).join('. ').slice(0, 500);
  return summary || cleaned.slice(0, 300);
}

// Generate content markdown file
function generateContentMd(fileName, text, summary) {
  let md = `# ${fileName} 내용\n\n`;
  if (summary) {
    md += `## 요약\n\n${summary}\n\n`;
  }
  md += `## 전체 내용\n\n`;
  md += '```\n' + text.slice(0, 100000) + '\n```\n';
  if (text.length > 100000) {
    md += `\n> (총 ${text.length.toLocaleString()}자 중 100,000자까지 표시)\n`;
  }
  return md;
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
            const fileBuf = Buffer.from(dlData.data, 'base64');
            fs.writeFileSync(path.join(folderPath, fname), fileBuf);
            downloadCount++;
            f._downloaded = true;
            console.log(`    → 다운로드: ${f.fileSeDc}_${f.fileNm} (${formatBytes(dlData.size)})`);

            // 파일 속성 추출
            f._properties = extractFileProperties(fileBuf, f.fileNm);
            if (Object.keys(f._properties).length > 1) {
              console.log(`    → 속성: ${Object.keys(f._properties).filter(k => k !== 'size_bytes' && k !== 'mime_type').join(', ')}`);
            }

            // 텍스트 내용 추출
            const textContent = await extractTextContent(fileBuf, f.fileNm);
            if (textContent && textContent.trim().length > 0) {
              f._content = textContent.trim();
              f._summary = generateSummary(f._content, f.fileNm);
              // MD 파일로 저장
              const contentMd = generateContentMd(f.fileNm, f._content, f._summary);
              const contentFname = sanitize(`${f.fileSeDc || '기타'}_${f.fileNm}_내용`, 200) + '.md';
              fs.writeFileSync(path.join(folderPath, contentFname), contentMd, 'utf8');
              console.log(`    → 내용: ${f._content.length.toLocaleString()}자 추출, 요약: ${f._summary.slice(0, 50)}...`);
            }

            // Supabase Storage 업로드
            const storagePath = `${regNo}/${fname}`;
            f._downloadUrl = await uploadToStorage(fileBuf, storagePath);
            if (f._downloadUrl) {
              console.log(`    → Storage: 업로드 완료`);
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
                  console.log(`    → ZIP 구조: ${zipEntries.filter(e => !e.path.endsWith('/')).length}개 파일 분석`);
                }
              } catch (ze) {
                console.log(`    → ZIP 분석 실패: ${ze.message}`);
              }
            }
          } else {
            f._downloaded = false;
            console.log(`    → 다운로드 실패: ${f.fileNm} (step ${dlData?.step || '?'}, ${dlData?.error || ''})`);
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
                download_url: f._downloadUrl || null,
                content: f._content ? f._content.slice(0, 100000) : null,
                summary: f._summary || null,
                content_length: f._content ? f._content.length : null,
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
