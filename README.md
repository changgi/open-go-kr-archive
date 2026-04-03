# 정보공개포털(open.go.kr) 문서 수집 시스템

정보공개포털의 사전정보공표 문서를 자동으로 수집하고, MCP 서버를 통해 AI 에이전트에서 검색/조회할 수 있으며, Next.js 대시보드로 시각화하는 시스템입니다.

## 아키텍처

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  open.go.kr │────▶│   Collector   │────▶│  Supabase   │
│   (API)     │     │  (Python)     │     │  (Postgres) │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          │                      │                      │
                    ┌─────▼─────┐         ┌──────▼──────┐       ┌──────▼──────┐
                    │ MCP Server│         │ Next.js Web │       │ GitHub      │
                    │ (TypeScript)        │ Dashboard   │       │ Actions     │
                    └───────────┘         └─────────────┘       │ (Cron)      │
                                                                └─────────────┘
```

## 프로젝트 구조

```
project_open/
├── collector/                  # Python 수집기
│   ├── open_go_kr_collector.py
│   └── requirements.txt
├── mcp-server/                 # MCP 서버 (TypeScript)
│   ├── src/
│   │   ├── index.ts
│   │   ├── tools/              # search, detail, collect, stats
│   │   ├── resources/          # recent, stats
│   │   └── lib/supabase.ts
│   ├── package.json
│   └── tsconfig.json
├── web/                        # Next.js 대시보드
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── .github/workflows/
│   └── collect.yml             # 6시간 주기 수집
├── vercel.json
└── README.md
```

## 설치 및 설정

### 1. 환경변수

`.env` 파일을 프로젝트 루트 및 `mcp-server/`에 생성:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```

### 2. Supabase 데이터베이스

Supabase 프로젝트를 생성하고 `supabase/migrations/001_initial_schema.sql`을 실행합니다.

### 3. Python 수집기

```bash
cd collector
pip install -r requirements.txt
python open_go_kr_collector.py -k "검색어" -n 50
```

### 4. MCP 서버

```bash
cd mcp-server
npm install
npm run build
npm start
```

Claude Desktop 설정 (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "open-go-kr": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_KEY": "your-service-role-key"
      }
    }
  }
}
```

### 5. 웹 대시보드

```bash
cd web
npm install
npm run dev
```

## MCP 도구

| 도구 | 설명 |
|------|------|
| `search_documents` | 키워드, 날짜, 기관, 공개구분으로 문서 검색 |
| `get_document` | 원문등록번호로 문서 상세 + 첨부파일 조회 |
| `collect_documents` | 수집기 실행 트리거 |
| `get_collection_stats` | 수집 통계 (총 건수, 기관 top 10, 최근 이력) |

## MCP 리소스

| URI | 설명 |
|-----|------|
| `documents://recent` | 최근 수집 문서 50건 |
| `documents://stats` | 수집 통계 요약 |

## 배포

### Vercel (웹 대시보드)

1. Vercel에 프로젝트를 연결합니다.
2. 환경변수 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`를 설정합니다.
3. `vercel.json`에 의해 `web/` 디렉토리가 빌드됩니다.

### GitHub Actions (자동 수집)

1. GitHub 리포지토리 Settings > Secrets에 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`를 추가합니다.
2. 6시간마다 자동 수집이 실행됩니다.
3. Actions 탭에서 수동 실행(workflow_dispatch)도 가능합니다.

## 데이터베이스 테이블

- **documents** - 수집된 문서 메타데이터 (원문등록번호, 제목, 기관, 날짜 등)
- **files** - 문서 첨부파일 정보
- **collection_runs** - 수집 실행 이력 및 통계
