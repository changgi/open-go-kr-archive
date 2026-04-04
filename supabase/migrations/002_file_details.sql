-- 파일 상세 메타데이터 컬럼 추가
ALTER TABLE files ADD COLUMN IF NOT EXISTS file_ext TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS is_archive BOOLEAN DEFAULT FALSE;
ALTER TABLE files ADD COLUMN IF NOT EXISTS archive_entries JSONB;
-- archive_entries 예시: [{"path":"문서.docx","size":12345,"modified":"2026-03-15"}]
