-- =============================================
-- 정보공개포털(open.go.kr) 문서 수집 시스템 스키마
-- =============================================

-- 1. documents: 수집된 문서 메타데이터
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prdctn_instt_regist_no TEXT UNIQUE NOT NULL,
  info_sj TEXT,
  doc_no TEXT,
  proc_instt_nm TEXT,
  chrg_dept_nm TEXT,
  charger_nm TEXT,
  prdctn_dt DATE,
  prsrv_pd_cd TEXT,
  unit_job_nm TEXT,
  opp_se_cd TEXT,
  opp_se_nm TEXT,
  nst_cl_nm TEXT,
  dta_redg_lmtt_end_ymd TEXT,
  instt_cd TEXT,
  instt_se_cd TEXT,
  keyword TEXT,
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'ok',
  note TEXT
);

-- 2. files: 문서에 첨부된 파일
CREATE TABLE files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  file_id TEXT,
  file_nm TEXT,
  file_se_dc TEXT,
  file_byte_num BIGINT,
  file_opp_yn TEXT,
  downloaded BOOLEAN DEFAULT FALSE,
  storage_path TEXT
);

-- 3. collection_runs: 수집 실행 이력
CREATE TABLE collection_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword TEXT,
  start_date DATE,
  end_date DATE,
  total_found INTEGER DEFAULT 0,
  total_collected INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT DEFAULT 'running'
);

-- 인덱스
CREATE INDEX idx_documents_prdctn_dt ON documents(prdctn_dt DESC);
CREATE INDEX idx_documents_proc_instt_nm ON documents(proc_instt_nm);
CREATE INDEX idx_documents_opp_se_cd ON documents(opp_se_cd);
CREATE INDEX idx_documents_collected_at ON documents(collected_at DESC);
CREATE INDEX idx_files_document_id ON files(document_id);

-- RLS 활성화
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;

-- 공개 읽기 정책
CREATE POLICY "Allow public read" ON documents FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON files FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON collection_runs FOR SELECT USING (true);
