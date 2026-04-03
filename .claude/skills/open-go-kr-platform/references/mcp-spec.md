# MCP 서버 구현 명세

## 목차

1. [개요](#1-개요)
2. [도구(Tools) 정의](#2-도구-정의)
3. [리소스(Resources) 정의](#3-리소스-정의)
4. [구현 가이드](#4-구현-가이드)

---

## 1. 개요

open.go.kr 원문정보 수집기를 Claude Desktop 등 MCP 클라이언트에서 사용할 수 있도록 MCP 서버를 구현한다.

기술 스택: TypeScript + `@modelcontextprotocol/sdk`

## 2. 도구(Tools) 정의

### search_documents

문서를 검색한다.

```json
{
  "name": "search_documents",
  "description": "open.go.kr 원문정보를 검색합니다. 키워드, 기관, 날짜 범위로 필터링 가능합니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "keyword": { "type": "string", "description": "검색어" },
      "startDate": { "type": "string", "description": "시작일 (YYYY-MM-DD)" },
      "endDate": { "type": "string", "description": "종료일 (YYYY-MM-DD)" },
      "insttNm": { "type": "string", "description": "기관명" },
      "oppSeCd": { "type": "string", "enum": ["1", "2", "3", "5"], "description": "공개구분 (1=공개, 2=부분공개, 3=비공개, 5=열람제한)" },
      "limit": { "type": "number", "description": "최대 결과 수 (기본: 20)" },
      "offset": { "type": "number", "description": "시작 위치 (기본: 0)" }
    }
  }
}
```

### get_document

문서 상세 정보를 조회한다.

```json
{
  "name": "get_document",
  "description": "특정 원문정보의 상세 메타데이터와 파일 목록을 조회합니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "registNo": { "type": "string", "description": "원문등록번호 (prdnNstRgstNo)" }
    },
    "required": ["registNo"]
  }
}
```

### collect_documents

문서를 수집한다 (수집기 실행).

```json
{
  "name": "collect_documents",
  "description": "조건에 맞는 원문정보를 수집합니다. 수집된 문서는 Supabase에 저장됩니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "keyword": { "type": "string", "description": "검색어" },
      "startDate": { "type": "string", "description": "시작일 (YYYY-MM-DD)" },
      "endDate": { "type": "string", "description": "종료일 (YYYY-MM-DD)" },
      "maxCount": { "type": "number", "description": "최대 수집 건수 (기본: 10)" }
    }
  }
}
```

### get_collection_stats

수집 통계를 조회한다.

```json
{
  "name": "get_collection_stats",
  "description": "원문정보 수집 통계를 조회합니다. 총 수집 건수, 기관별 분포, 최근 수집 이력 등.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

## 3. 리소스(Resources) 정의

### documents://recent

최근 수집된 문서 목록을 리소스로 제공한다.

```json
{
  "uri": "documents://recent",
  "name": "최근 수집 문서",
  "description": "최근 수집된 원문정보 문서 목록 (최대 50건)",
  "mimeType": "application/json"
}
```

### documents://stats

수집 통계 요약을 리소스로 제공한다.

```json
{
  "uri": "documents://stats",
  "name": "수집 통계",
  "description": "원문정보 수집 통계 요약 (총 건수, 기관별, 날짜별)",
  "mimeType": "application/json"
}
```

## 4. 구현 가이드

### 프로젝트 구조

```
mcp-server/
├── src/
│   ├── index.ts           # MCP 서버 메인
│   ├── tools/
│   │   ├── search.ts      # search_documents
│   │   ├── detail.ts      # get_document
│   │   ├── collect.ts     # collect_documents
│   │   └── stats.ts       # get_collection_stats
│   ├── resources/
│   │   ├── recent.ts      # documents://recent
│   │   └── stats.ts       # documents://stats
│   └── lib/
│       └── supabase.ts    # Supabase 클라이언트
├── package.json
├── tsconfig.json
└── .env.example
```

### Supabase 연동

모든 도구와 리소스는 Supabase를 데이터 소스로 사용한다. `collect_documents`만 실제 open.go.kr API를 호출한다.

### Claude Desktop 설정

```json
{
  "mcpServers": {
    "open-go-kr": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "...",
        "SUPABASE_SERVICE_KEY": "..."
      }
    }
  }
}
```
