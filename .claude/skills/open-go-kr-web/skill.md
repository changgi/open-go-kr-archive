---
name: open-go-kr-web
description: "open.go.kr 원문정보 수집 결과를 검색·열람하는 Next.js 웹 대시보드를 구현하는 스킬. Supabase 데이터 소스, Tailwind CSS 반응형 UI, Vercel 배포 지원, 실시간 업데이트 포함. '원문공개 대시보드', '수집 결과 웹페이지', '정보공개 웹 UI' 등의 요청 시 사용할 것."
---

# open.go.kr 웹 대시보드 구현

수집된 원문정보를 웹에서 검색·열람할 수 있는 Next.js 대시보드를 구현한다.

## 기술 스택

- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- @supabase/supabase-js + @supabase/ssr
- Vercel 배포

## 프로젝트 구조

```
web/
├── app/
│   ├── layout.tsx              # 루트 레이아웃
│   ├── page.tsx                # 대시보드 홈
│   ├── documents/
│   │   ├── page.tsx            # 문서 목록
│   │   └── [id]/
│   │       └── page.tsx        # 문서 상세
│   ├── stats/
│   │   └── page.tsx            # 통계
│   └── api/
│       └── collect/
│           └── route.ts        # 수집 트리거 API
├── components/
│   ├── DocumentCard.tsx        # 문서 카드
│   ├── SearchBar.tsx           # 검색바
│   ├── Pagination.tsx          # 페이지네이션
│   ├── StatsChart.tsx          # 통계 차트
│   └── Header.tsx              # 헤더/내비게이션
├── lib/
│   ├── supabase/
│   │   ├── server.ts           # 서버 클라이언트
│   │   └── client.ts           # 브라우저 클라이언트
│   └── types.ts                # 타입 정의
├── package.json
├── tailwind.config.ts
├── next.config.js
├── .env.example
└── .env.local
```

## 페이지별 구현

### 1. 대시보드 홈 (`/`)

Server Component로 구현. Supabase에서 최근 수집 문서 10건과 통계 요약을 조회한다.

표시 항목:
- 총 수집 문서 수
- 오늘 수집 건수
- 기관별 수집 비율 (상위 5개)
- 최근 수집 문서 목록 (카드 형태)
- 마지막 수집 시각

### 2. 문서 목록 (`/documents`)

Server Component + URL 검색 파라미터로 구현. Supabase의 `documents` 테이블을 조회한다.

기능:
- 키워드 검색 (제목, 기관명, 문서번호)
- 필터: 공개구분, 기관명, 날짜 범위
- 정렬: 생산일자, 수집일자, 제목
- 페이지네이션 (20건/페이지)

### 3. 문서 상세 (`/documents/[id]`)

Server Component. `documents` 테이블 + `files` 테이블을 조인 조회한다.

표시 항목:
- 메타데이터 전체 (표 형태)
- 파일 목록 (다운로드 링크 또는 원문 사이트 링크)
- 원문 사이트 바로가기

### 4. 통계 (`/stats`)

Client Component (차트 인터랙션). 집계 쿼리로 통계를 표시한다.

차트:
- 날짜별 수집 추이 (라인 차트)
- 기관별 분포 (파이 차트)
- 공개구분별 비율 (바 차트)

차트 라이브러리: recharts (가볍고 React 친화적)

### 5. 수집 트리거 API (`/api/collect`)

POST 요청으로 수집을 트리거한다. Vercel Cron Jobs에서 호출 가능하도록 `CRON_SECRET` 검증을 포함한다.

```typescript
// 인증: Authorization 헤더 또는 CRON_SECRET 검증
// 본문: { keyword?, startDate?, endDate?, maxCount? }
// 응답: { success: boolean, runId: string }
```

## Supabase 연동

### 서버 클라이언트 (Server Components)

`@supabase/ssr`의 `createServerClient`를 사용한다. 서비스 롤 키로 데이터를 조회한다.

### 실시간 업데이트

Supabase Realtime으로 `documents` 테이블의 INSERT 이벤트를 구독한다. 새 문서가 추가되면 대시보드에 실시간 알림을 표시한다.

## UI 디자인 원칙

- Tailwind CSS로 반응형 구현 (모바일 우선)
- 한글 폰트: Pretendard 또는 Noto Sans KR
- 색상: 정부24 스타일의 블루 계열 (#1a56db 기반)
- 빈 상태(Empty State): 데이터 없을 때 안내 메시지 + 수집 시작 버튼
- 로딩 상태: Skeleton UI

## 환경변수

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
```

## Vercel 배포 호환

- `next.config.js`에 output 설정 불필요 (Vercel 기본 지원)
- `vercel.json`에 cron 설정 포함
- 환경변수는 Vercel 대시보드에서 설정
