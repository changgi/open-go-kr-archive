---
name: open-go-kr-platform
description: "open.go.kr 원문정보 수집 시스템의 인프라를 구축하는 스킬. Supabase DB 스키마, MCP 서버(TypeScript), GitHub Actions 정기수집 워크플로우, Vercel 배포 설정, README 작성을 포함. 'Supabase 스키마', 'MCP 서버', '배포 설정', 'GitHub Actions 수집 자동화' 등의 요청 시 사용할 것."
---

# open.go.kr 플랫폼 인프라 구축

수집 시스템의 데이터베이스, MCP 서버, CI/CD, 배포를 구축한다.

## 작업 1: Supabase 스키마

### 테이블 3개 생성

**documents** — 수집된 문서 메타데이터
```sql
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
```

**files** — 문서에 첨부된 파일
```sql
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
```

**collection_runs** — 수집 실행 이력
```sql
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
```

### 인덱스

```sql
CREATE INDEX idx_documents_prdctn_dt ON documents(prdctn_dt DESC);
CREATE INDEX idx_documents_proc_instt_nm ON documents(proc_instt_nm);
CREATE INDEX idx_documents_opp_se_cd ON documents(opp_se_cd);
CREATE INDEX idx_documents_collected_at ON documents(collected_at DESC);
CREATE INDEX idx_files_document_id ON files(document_id);
```

### RLS 정책

웹 대시보드는 읽기 전용 접근만 허용한다. 수집기와 MCP 서버는 서비스 롤 키를 사용한다.

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON documents FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON files FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON collection_runs FOR SELECT USING (true);
```

### Realtime 활성화

`documents` 테이블에 Realtime을 활성화하여 웹 대시보드에서 실시간 업데이트를 수신한다.

## 작업 2: MCP 서버

TypeScript로 `@modelcontextprotocol/sdk`를 사용하여 MCP 서버를 구현한다. 상세 도구/리소스 명세는 `references/mcp-spec.md`를 참조한다.

### 프로젝트 구조

```
mcp-server/
├── src/
│   ├── index.ts           # 서버 엔트리포인트
│   ├── tools/             # MCP 도구 구현
│   ├── resources/         # MCP 리소스 구현
│   └── lib/
│       └── supabase.ts    # Supabase 클라이언트
├── package.json
├── tsconfig.json
└── .env.example
```

### 핵심 도구 4개

1. `search_documents` — Supabase 쿼리로 문서 검색
2. `get_document` — 특정 문서 상세 조회
3. `collect_documents` — 수집 실행 트리거
4. `get_collection_stats` — 통계 조회

### 빌드 및 실행

```bash
cd mcp-server
npm install
npm run build
node dist/index.js
```

## 작업 3: GitHub Actions

### 정기 수집 워크플로우

```yaml
# .github/workflows/collect.yml
name: Scheduled Collection
on:
  schedule:
    - cron: '0 */6 * * *'  # 6시간마다
  workflow_dispatch:         # 수동 실행 가능
    inputs:
      keyword:
        description: '검색어'
        required: false
      max_count:
        description: '최대 수집 건수'
        default: '50'
```

Python 수집기를 실행하고, Supabase에 결과를 저장한다. 환경변수(`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`)는 GitHub Secrets에 설정한다.

### 워크플로우 단계

1. Python 3.11 설정
2. 의존성 설치 (`pip install -r collector/requirements.txt`)
3. 수집 실행 (`python collector/open_go_kr_collector.py`)
4. 결과 아티팩트 업로드 (선택)

## 작업 4: Vercel 설정

### vercel.json

```json
{
  "crons": [
    {
      "path": "/api/collect",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

Vercel Cron으로도 수집을 트리거할 수 있다. GitHub Actions와 이중으로 설정하여 안정성을 높인다.

### 환경변수

Vercel 대시보드에서 설정:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`

## 작업 5: README.md

프로젝트 설명, 설치 방법, 사용법, 배포 가이드를 포함하는 README를 작성한다.

주요 섹션:
1. 프로젝트 소개
2. 아키텍처 다이어그램
3. 빠른 시작 (Quick Start)
4. Python 수집기 사용법
5. 웹 대시보드 로컬 실행
6. MCP 서버 설정
7. 배포 가이드 (Vercel + GitHub Actions)
8. 환경변수 목록
9. 라이선스
