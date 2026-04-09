/**
 * 로컬 SQLite DB — 수집 단계에서 Supabase 대신 사용
 * 네트워크 지연 없이 즉시 저장/조회, row limit 없음
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let db = null;

export function initDB(dbPath) {
  db = new Database(dbPath || path.join(__dirname, 'collection.db'));
  db.pragma('journal_mode = WAL');       // 동시 읽기/쓰기
  db.pragma('synchronous = NORMAL');     // 속도 우선
  db.pragma('cache_size = -64000');      // 64MB 캐시

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      prdctn_instt_regist_no TEXT PRIMARY KEY,
      info_sj TEXT, doc_no TEXT, proc_instt_nm TEXT,
      chrg_dept_nm TEXT, charger_nm TEXT,
      prdctn_dt TEXT, prdctn_dt_raw TEXT,
      prsrv_pd_cd TEXT, unit_job_nm TEXT,
      opp_se_cd TEXT, opp_se_nm TEXT,
      nst_cl_nm TEXT, dta_redg_lmtt_end_ymd TEXT,
      instt_cd TEXT, instt_se_cd TEXT,
      keywords TEXT, full_dept_nm TEXT,
      file_count INTEGER DEFAULT 0, downloaded_count INTEGER DEFAULT 0,
      original_url TEXT, status TEXT DEFAULT 'meta_only',
      doc_type TEXT, recipient TEXT,
      sender_info TEXT, receiver_info TEXT,
      ai_summary TEXT, six_w_analysis TEXT,
      one_line_summary TEXT, core_content TEXT,
      brm_category TEXT, approval_chain TEXT,
      contact_info TEXT, body_summary TEXT,
      collected_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(prdctn_instt_regist_no),
      file_nm TEXT, file_se_dc TEXT,
      file_byte_num INTEGER, file_opp_yn TEXT,
      file_ext TEXT, is_archive INTEGER DEFAULT 0,
      downloaded INTEGER DEFAULT 0,
      content TEXT, summary TEXT, content_length INTEGER,
      file_properties TEXT, archive_entries TEXT,
      download_url TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_doc_collected ON documents(collected_at);
    CREATE INDEX IF NOT EXISTS idx_files_doc ON files(document_id);
  `);

  return db;
}

export function getDB() { return db; }

// ── 문서 저장/업데이트 (즉시, 네트워크 없음) ──
const upsertDocStmt = () => db.prepare(`
  INSERT INTO documents (
    prdctn_instt_regist_no, info_sj, doc_no, proc_instt_nm,
    chrg_dept_nm, charger_nm, prdctn_dt, prdctn_dt_raw,
    prsrv_pd_cd, unit_job_nm, opp_se_cd, opp_se_nm,
    nst_cl_nm, instt_cd, instt_se_cd,
    keywords, full_dept_nm, original_url, status
  ) VALUES (
    @prdctn_instt_regist_no, @info_sj, @doc_no, @proc_instt_nm,
    @chrg_dept_nm, @charger_nm, @prdctn_dt, @prdctn_dt_raw,
    @prsrv_pd_cd, @unit_job_nm, @opp_se_cd, @opp_se_nm,
    @nst_cl_nm, @instt_cd, @instt_se_cd,
    @keywords, @full_dept_nm, @original_url, @status
  ) ON CONFLICT(prdctn_instt_regist_no) DO UPDATE SET
    info_sj=excluded.info_sj, doc_no=excluded.doc_no,
    proc_instt_nm=excluded.proc_instt_nm,
    chrg_dept_nm=excluded.chrg_dept_nm,
    prsrv_pd_cd=COALESCE(excluded.prsrv_pd_cd, prsrv_pd_cd),
    nst_cl_nm=CASE WHEN LENGTH(excluded.nst_cl_nm) > LENGTH(COALESCE(nst_cl_nm,'')) THEN excluded.nst_cl_nm ELSE nst_cl_nm END,
    file_count=COALESCE(excluded.file_count, file_count),
    downloaded_count=COALESCE(excluded.downloaded_count, downloaded_count),
    original_url=COALESCE(excluded.original_url, original_url),
    status=CASE WHEN excluded.status='ok' THEN 'ok' ELSE status END
`);

let _upsertDoc = null;
export function upsertDocument(doc) {
  if (!_upsertDoc) _upsertDoc = upsertDocStmt();
  _upsertDoc.run({
    prdctn_instt_regist_no: doc.prdctn_instt_regist_no || null,
    info_sj: doc.info_sj || null,
    doc_no: doc.doc_no || null,
    proc_instt_nm: doc.proc_instt_nm || null,
    chrg_dept_nm: doc.chrg_dept_nm || null,
    charger_nm: doc.charger_nm || null,
    prdctn_dt: doc.prdctn_dt || null,
    prdctn_dt_raw: doc.prdctn_dt_raw || null,
    prsrv_pd_cd: doc.prsrv_pd_cd || null,
    unit_job_nm: doc.unit_job_nm || null,
    opp_se_cd: doc.opp_se_cd || null,
    opp_se_nm: doc.opp_se_nm || null,
    nst_cl_nm: doc.nst_cl_nm || null,
    instt_cd: doc.instt_cd || null,
    instt_se_cd: doc.instt_se_cd || null,
    keywords: doc.keywords || null,
    full_dept_nm: doc.full_dept_nm || null,
    original_url: doc.original_url || null,
    status: doc.status || 'meta_only',
  });
}

// 배치 저장 (트랜잭션, 1만건도 1초 미만)
export function upsertDocuments(docs) {
  const tx = db.transaction((items) => {
    for (const doc of items) upsertDocument(doc);
  });
  tx(docs);
}

// 상세 업데이트
export function updateDocDetail(regNo, detail) {
  const sets = Object.entries(detail)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => `${k}=@${k}`).join(', ');
  if (!sets) return;
  db.prepare(`UPDATE documents SET ${sets} WHERE prdctn_instt_regist_no=@regNo`)
    .run({ regNo, ...detail });
}

// 파일 저장
export function upsertFile(file) {
  db.prepare(`
    INSERT INTO files (file_id, document_id, file_nm, file_se_dc, file_byte_num, file_opp_yn, file_ext, is_archive, downloaded, content, summary, content_length, file_properties, archive_entries)
    VALUES (@file_id, @document_id, @file_nm, @file_se_dc, @file_byte_num, @file_opp_yn, @file_ext, @is_archive, @downloaded, @content, @summary, @content_length, @file_properties, @archive_entries)
    ON CONFLICT(file_id) DO UPDATE SET
      downloaded=COALESCE(excluded.downloaded, downloaded),
      content=COALESCE(excluded.content, content),
      summary=COALESCE(excluded.summary, summary)
  `).run({
    file_id: file.file_id || null,
    document_id: file.document_id || null,
    file_nm: file.file_nm || null,
    file_se_dc: file.file_se_dc || null,
    file_byte_num: file.file_byte_num || null,
    file_opp_yn: file.file_opp_yn || null,
    file_ext: file.file_ext || null,
    is_archive: file.is_archive ? 1 : 0,
    downloaded: file.downloaded ? 1 : 0,
    content: file.content || null,
    summary: file.summary || null,
    content_length: file.content_length || null,
    file_properties: file.file_properties || null,
    archive_entries: file.archive_entries || null,
  });
}

// ── 조회 ──
export function getCollectedSet() {
  const rows = db.prepare('SELECT prdctn_instt_regist_no FROM documents').all();
  return new Set(rows.map(r => r.prdctn_instt_regist_no));
}

export function getMetaOnlyDocs(limit = 100000) {
  return db.prepare('SELECT * FROM documents WHERE status = ? ORDER BY collected_at ASC LIMIT ?')
    .all('meta_only', limit);
}

export function getStats() {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
      SUM(CASE WHEN status='meta_only' THEN 1 ELSE 0 END) as meta_only,
      SUM(CASE WHEN prsrv_pd_cd IS NOT NULL THEN 1 ELSE 0 END) as has_retention,
      SUM(CASE WHEN one_line_summary IS NOT NULL THEN 1 ELSE 0 END) as has_ai,
      SUM(CASE WHEN downloaded_count > 0 THEN 1 ELSE 0 END) as has_files
    FROM documents
  `).get();
}

// ── Supabase 동기화 ──
export async function syncToSupabase(supabaseUrl, supabaseKey, batchSize = 100) {
  if (!supabaseUrl || !supabaseKey) return 0;

  // ok 상태 문서 중 Supabase에 없는 것을 동기화
  const docs = db.prepare('SELECT * FROM documents WHERE status = ? ORDER BY collected_at ASC LIMIT ?')
    .all('ok', 10000);

  let synced = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const chunk = docs.slice(i, i + batchSize);
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/documents?on_conflict=prdctn_instt_regist_no`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(chunk),
      });
      if (res.ok) synced += chunk.length;
    } catch {}
  }
  return synced;
}

export function closeDB() { if (db) db.close(); }
