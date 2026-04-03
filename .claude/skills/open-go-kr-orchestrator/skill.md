---
name: open-go-kr-orchestrator
description: "open.go.kr 원문정보 수집 시스템 전체를 구축하는 오케스트레이터. Python 수집기, Next.js 대시보드, Supabase DB, MCP 서버, GitHub Actions, Vercel 배포를 에이전트 팀으로 병렬 개발한다. '원문공개 시스템 구축', '정보공개포털 수집 사이트 만들기', 'open.go.kr 프로젝트 시작' 등의 요청 시 반드시 이 스킬을 사용할 것."
---

# open.go.kr 원문정보 수집 시스템 오케스트레이터

에이전트 팀을 조율하여 전체 시스템을 구축한다.

## 실행 모드: 에이전트 팀

## 에이전트 구성

| 팀원 | 에이전트 정의 | 타입 | 역할 | 스킬 |
|------|-------------|------|------|------|
| collector-dev | `.claude/agents/collector-dev.md` | general-purpose | Python 수집기 코어 | open-go-kr-collect |
| web-dev | `.claude/agents/web-dev.md` | general-purpose | Next.js 대시보드 | open-go-kr-web |
| platform-dev | `.claude/agents/platform-dev.md` | general-purpose | Supabase + MCP + CI/CD | open-go-kr-platform |

## 워크플로우

### Phase 1: 준비

1. 사용자 입력 분석 — 검색 조건, 배포 옵션, 커스텀 요구사항 파악
2. 작업 디렉토리에 `_workspace/` 생성
3. PRD 문서를 `_workspace/00_input/prd.md`에 복사

### Phase 2: 팀 구성

1. 팀 생성:

```
TeamCreate(
  team_name: "open-go-kr-team",
  description: "open.go.kr 원문정보 수집 시스템 개발 팀"
)
```

2. 팀원 스폰 — 에이전트 정의 파일의 내용을 읽어 프롬프트에 포함:

```
Agent(
  name: "platform-dev",
  model: "opus",
  team_name: "open-go-kr-team",
  prompt: "<.claude/agents/platform-dev.md 내용> + <.claude/skills/open-go-kr-platform/skill.md 내용> + 작업 지시"
)

Agent(
  name: "collector-dev",
  model: "opus",
  team_name: "open-go-kr-team",
  prompt: "<.claude/agents/collector-dev.md 내용> + <.claude/skills/open-go-kr-collect/skill.md 내용> + 작업 지시"
)

Agent(
  name: "web-dev",
  model: "opus",
  team_name: "open-go-kr-team",
  prompt: "<.claude/agents/web-dev.md 내용> + <.claude/skills/open-go-kr-web/skill.md 내용> + 작업 지시"
)
```

3. 작업 등록:

| 작업 | 담당 | 의존성 |
|------|------|--------|
| Supabase 스키마 생성 | platform-dev | 없음 |
| Python 수집기 구현 | collector-dev | Supabase 스키마 |
| Supabase 동기화 모듈 | collector-dev | Supabase 스키마 |
| Next.js 대시보드 구현 | web-dev | Supabase 스키마 |
| MCP 서버 구현 | platform-dev | Supabase 스키마 |
| GitHub Actions 워크플로우 | platform-dev | Python 수집기 |
| Vercel 배포 설정 | platform-dev | Next.js 대시보드 |
| README.md 작성 | platform-dev | 모든 작업 |

**핵심:** platform-dev가 Supabase 스키마를 가장 먼저 완료하고 팀원에게 SendMessage로 공유해야 한다. 다른 작업은 이 스키마에 의존한다.

### Phase 3: 병렬 개발

**실행 방식:** 팀원들이 자체 조율

팀원 간 통신 규칙:
- platform-dev → collector-dev: Supabase 스키마 완료 시 SendMessage로 공유
- platform-dev → web-dev: Supabase 스키마 + 환경변수 가이드 SendMessage로 공유
- collector-dev → web-dev: 수집 데이터 JSON 구조 확정 시 SendMessage로 공유
- collector-dev → platform-dev: 수집기 완료 시 알림 (GitHub Actions 작성 시작)
- web-dev → platform-dev: 대시보드 완료 시 알림 (Vercel 설정 시작)

산출물 저장:

| 팀원 | 출력 경로 |
|------|----------|
| platform-dev | `supabase/`, `mcp-server/`, `.github/`, `vercel.json`, `README.md` |
| collector-dev | `collector/` |
| web-dev | `web/` |

리더 모니터링:
- 팀원 유휴 알림 수신 시 다음 작업 할당 여부 확인
- platform-dev가 스키마를 완료했는지 우선 확인
- 모든 팀원이 idle이면 Phase 4로 진행

### Phase 4: 통합 검증

1. 모든 팀원의 작업 완료 대기
2. 파일 구조 검증:
   - `collector/open_go_kr_collector.py` 존재 여부
   - `web/package.json` 존재 여부
   - `mcp-server/package.json` 존재 여부
   - `.github/workflows/collect.yml` 존재 여부
   - `vercel.json` 존재 여부
   - `README.md` 존재 여부
3. 의존성 일관성 확인:
   - collector의 Supabase 테이블명이 스키마와 일치하는지
   - web의 Supabase 쿼리가 스키마와 일치하는지
   - MCP 서버의 도구 정의가 실제 기능과 일치하는지
4. 문제 발견 시 해당 팀원에게 SendMessage로 수정 요청

### Phase 5: 정리

1. 팀원들에게 종료 요청 (SendMessage)
2. 팀 정리 (TeamDelete)
3. `_workspace/` 보존
4. 사용자에게 결과 요약 보고:
   - 생성된 파일 목록
   - 배포 가이드 (다음 단계)
   - 환경변수 설정 안내

## 에러 핸들링

| 상황 | 대응 |
|------|------|
| platform-dev 스키마 생성 실패 | 리더가 직접 Supabase MCP로 스키마 생성 후 팀원에게 공유 |
| 팀원 작업 실패 | 1회 재시도 지시, 재실패 시 리더가 보완 |
| 팀원 간 데이터 불일치 | 리더가 중재하여 표준 확정 후 수정 지시 |
| 외부 서비스 장애 | 해당 기능을 TODO로 남기고 나머지 진행 |

## 데이터 전달 프로토콜

- **태스크 기반:** TaskCreate/TaskUpdate로 작업 상태 추적
- **메시지 기반:** SendMessage로 실시간 정보 공유 (스키마, 데이터 구조)
- **파일 기반:** 각 팀원이 자신의 디렉토리에 코드 저장

## 테스트 시나리오

### 정상 흐름

1. 오케스트레이터 시작 → Phase 1 준비
2. 팀 생성 → platform-dev가 Supabase 스키마 먼저 생성
3. 스키마 공유 → collector-dev, web-dev 병렬 개발 시작
4. 모든 팀원 완료 → 통합 검증 통과
5. 팀 정리 → 사용자에게 결과 보고

### 에러 흐름

1. platform-dev가 Supabase 스키마 생성 실패 (MCP 연결 문제)
2. 리더가 직접 SQL 마이그레이션 파일로 스키마 정의
3. 스키마 파일을 `_workspace/`에 저장 후 팀원에게 공유
4. 나머지 워크플로우 정상 진행
