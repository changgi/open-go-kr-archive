#!/usr/bin/env node
/**
 * 기존 평평한 폴더 구조를 샤드 구조로 이동
 *
 * Before: full_collection/12345_제목/
 * After:  full_collection/0012/12345_제목/
 *
 * 폴더 내용은 rename(mv)으로 이동하므로 매우 빠름 (파일 복사 X)
 * 기존 파일은 절대 삭제하지 않음
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const dir = args[0] || './full_collection';
const dryRun = args.includes('--dry-run');

function now() { return Date.now(); }
function ts() { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }

log(`대상 디렉토리: ${dir}`);
if (dryRun) log('[DRY-RUN 모드] 실제 이동 없음');

// 평평한 폴더 나열 (샤드 폴더 제외)
log('폴더 목록 로딩...');
const t0 = now();
const entries = fs.readdirSync(dir, { withFileTypes: true });
const flatFolders = [];
for (const e of entries) {
  if (!e.isDirectory()) continue;
  // 이미 샤드(숫자 4자리) 건너뛰기
  if (/^\d{4}$/.test(e.name)) continue;
  // "숫자_제목" 형식만
  const m = e.name.match(/^(\d+)_/);
  if (!m) continue;
  flatFolders.push({ name: e.name, num: parseInt(m[1], 10) });
}
log(`평평한 폴더: ${flatFolders.length.toLocaleString()}개 (로딩 ${((now()-t0)/1000).toFixed(1)}s)`);

if (flatFolders.length === 0) {
  log('이동할 폴더 없음');
  process.exit(0);
}

// 샤드별 개수 집계 (미리 디렉토리 생성) — 100 단위
const shards = new Map();
for (const f of flatFolders) {
  const shard = Math.floor(f.num / 100).toString().padStart(4, '0');
  shards.set(shard, (shards.get(shard) || 0) + 1);
}
log(`샤드 수: ${shards.size}개 (${[...shards.keys()].sort()[0]} ~ ${[...shards.keys()].sort().pop()})`);

// 샤드 디렉토리 일괄 생성
for (const shard of shards.keys()) {
  const p = path.join(dir, shard);
  if (!dryRun && !fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}
log(`샤드 디렉토리 생성 완료`);

// 이동
let moved = 0, errors = 0, skipped = 0;
const start = now();
const total = flatFolders.length;

for (const f of flatFolders) {
  const shard = Math.floor(f.num / 100).toString().padStart(4, '0');
  const src = path.join(dir, f.name);
  const dst = path.join(dir, shard, f.name);

  if (dryRun) {
    moved++;
    if (moved <= 5) log(`  [DRY] ${f.name} → ${shard}/`);
    continue;
  }

  try {
    // 이미 대상에 있으면 건너뜀 (기존 보존)
    if (fs.existsSync(dst)) {
      skipped++;
      continue;
    }
    fs.renameSync(src, dst);
    moved++;
  } catch (e) {
    errors++;
    if (errors <= 10) log(`  [오류] ${f.name}: ${e.code || e.message}`);
  }

  if (moved % 5000 === 0) {
    const elapsed = (now() - start) / 1000;
    const rate = (moved / elapsed).toFixed(0);
    const eta = Math.round((total - moved) / parseFloat(rate));
    log(`  이동 ${moved.toLocaleString()}/${total.toLocaleString()} | ${rate}개/초 | ETA ${eta}s`);
  }
}

const took = ((now() - start) / 1000).toFixed(1);
log(`=== 완료 ===`);
log(`이동: ${moved.toLocaleString()} | 건너뜀: ${skipped.toLocaleString()} | 오류: ${errors.toLocaleString()}`);
log(`소요: ${took}초`);
