#!/usr/bin/env node
/**
 * 수집 현황 조회
 *
 * 사용법:
 *   node status.mjs              # 한 번 표시
 *   node status.mjs --watch      # 30초마다 갱신
 *   node status.mjs --watch 10   # 10초마다 갱신
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { initDB, getStats, getAiUsageStats, closeDB } from './local_db.mjs';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const interval = parseInt(args.find((a, i) => args[i-1] === '--watch') || args[args.indexOf('--watch')+1] || '30') || 30;
const outputDir = './full_collection';

function fmtNum(n) { return (n || 0).toLocaleString(); }
function bar(pct, width = 30) {
  const filled = Math.round(width * pct / 100);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function getProcesses() {
  try {
    const out = execSync(`powershell -command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -like '*_collect.mjs*' -or $_.CommandLine -like '*year_range*' } | ForEach-Object { [PSCustomObject]@{ PID=$_.ProcessId; CMD=($_.CommandLine -replace 'C:\\\\Program Files\\\\nodejs\\\\node.exe ','') } } | ConvertTo-Json -Compress"`, { encoding: 'utf8', timeout: 10000 });
    if (!out.trim()) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function getLastLine(file, skipWarnings = true) {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    const size = Math.min(stat.size, 8192);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    if (skipWarnings) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].startsWith('Warning:')) return lines[i];
      }
    }
    return lines[lines.length - 1];
  } catch { return null; }
}

function countShardFolders() {
  try {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    const shards = entries.filter(e => e.isDirectory() && /^\d{4}$/.test(e.name));
    let total = 0;
    let maxShard = 0;
    for (const s of shards) {
      const count = fs.readdirSync(path.join(outputDir, s.name)).length;
      total += count;
      if (count > maxShard) maxShard = count;
    }
    return { shardCount: shards.length, folderCount: total, maxShard };
  } catch { return { shardCount: 0, folderCount: 0, maxShard: 0 }; }
}

function display() {
  if (watch) console.clear();
  initDB(path.join(outputDir, 'collection.db'));
  const s = getStats();
  const okPct = s.total > 0 ? (s.ok / s.total * 100) : 0;
  const aiPct = s.total > 0 ? (s.has_ai / s.total * 100) : 0;
  const filePct = s.total > 0 ? (s.has_files / s.total * 100) : 0;

  const procs = getProcesses();
  const shard = countShardFolders();

  const now = new Date().toLocaleString('ko-KR');

  console.log('┌─────────────────────────────────────────────────────────────────┐');
  console.log(`│  📊 open.go.kr 수집 현황                              ${now.padEnd(10)}│`);
  console.log('├─────────────────────────────────────────────────────────────────┤');
  console.log(`│  전체 문서      ${fmtNum(s.total).padStart(12)}건                                   │`);
  console.log(`│  상세 완료      ${fmtNum(s.ok).padStart(12)}건  (${okPct.toFixed(1).padStart(5)}%)  ${bar(okPct, 20)} │`);
  console.log(`│  대기 중        ${fmtNum(s.meta_only).padStart(12)}건                                   │`);
  console.log(`│  AI 분석        ${fmtNum(s.has_ai).padStart(12)}건  (${aiPct.toFixed(1).padStart(5)}%)  ${bar(aiPct, 20)} │`);
  console.log(`│  파일 보유      ${fmtNum(s.has_files).padStart(12)}건  (${filePct.toFixed(1).padStart(5)}%)  ${bar(filePct, 20)} │`);
  console.log(`│  보존기간 수집  ${fmtNum(s.has_retention).padStart(12)}건                                   │`);
  console.log('├─────────────────────────────────────────────────────────────────┤');
  console.log(`│  📁 폴더: ${fmtNum(shard.folderCount)}개 (${shard.shardCount}샤드, 최대 ${shard.maxShard}개/샤드)               `.slice(0, 67) + '│');
  console.log('├─────────────────────────────────────────────────────────────────┤');

  // Claude API 크레딧 통계
  const aiStats = getAiUsageStats();
  if (aiStats) {
    const fmtCost = c => '$' + (c || 0).toFixed(2);
    console.log(`│  💰 Claude API 누적 사용                                         │`.slice(0, 67));
    console.log(`│     총 호출: ${fmtNum(aiStats.total_calls).padStart(8)}회 | 성공: ${fmtNum(aiStats.ok_calls).padStart(6)} | 실패: ${fmtNum(aiStats.failed_calls).padStart(5)}  │`.slice(0, 67));
    console.log(`│     누적 비용: ${fmtCost(aiStats.total_cost).padStart(10)}                                    │`.slice(0, 67));
    console.log(`│     토큰: in ${fmtNum(aiStats.total_input_tokens).padStart(11)} / out ${fmtNum(aiStats.total_output_tokens).padStart(11)}      │`.slice(0, 67));
    console.log(`│  ⚡ 최근 사용량                                                  │`.slice(0, 67));
    console.log(`│     1분:  ${String(aiStats.last_1m.calls).padStart(4)}회  ${fmtCost(aiStats.last_1m.cost).padStart(8)}                              │`.slice(0, 67));
    console.log(`│     10분: ${String(aiStats.last_10m.calls).padStart(4)}회  ${fmtCost(aiStats.last_10m.cost).padStart(8)}                              │`.slice(0, 67));
    console.log(`│     1시간: ${String(aiStats.last_1h.calls).padStart(4)}회 ${fmtCost(aiStats.last_1h.cost).padStart(8)}                              │`.slice(0, 67));
    console.log('├─────────────────────────────────────────────────────────────────┤');
  }

  console.log(`│  🏃 실행 중인 프로세스: ${procs.length}개                                       │`.slice(0, 67));

  for (const p of procs.slice(0, 4)) {
    let cmd = (p.CMD || '').replace(/C:\\\\[^ ]*nodejs\\\\node\.exe /, '').trim();
    cmd = cmd.replace(/\.\/[a-z_]+\.mjs/, m => m).slice(0, 55);
    console.log(`│    [${String(p.PID).padEnd(5)}] ${cmd.padEnd(55)}│`.slice(0, 67));
  }

  // 로그 tail
  console.log('├─────────────────────────────────────────────────────────────────┤');
  console.log('│  📜 최신 로그                                                     │');
  // 가장 최근 로그 파일 자동 선택
  const findLatestLog = (prefix) => {
    try {
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith(prefix) && f.endsWith('.log'));
      if (!files.length) return null;
      files.sort((a, b) => fs.statSync(path.join(outputDir, b)).mtimeMs - fs.statSync(path.join(outputDir, a)).mtimeMs);
      return path.join(outputDir, files[0]);
    } catch { return null; }
  };
  const logs = [
    { name: 'detail', file: findLatestLog('detail_collect') },
    { name: 'year  ', file: findLatestLog('year_range') },
  ].filter(l => l.file);
  for (const l of logs) {
    const line = getLastLine(l.file);
    if (line) {
      const short = line.slice(0, 55);
      console.log(`│  ${l.name}: ${short.padEnd(56)} │`.slice(0, 67));
    }
  }
  console.log('└─────────────────────────────────────────────────────────────────┘');
  if (watch) console.log(`\n  ${interval}초마다 갱신 (Ctrl+C 종료)`);

  closeDB();
}

display();
if (watch) {
  setInterval(display, interval * 1000);
}
