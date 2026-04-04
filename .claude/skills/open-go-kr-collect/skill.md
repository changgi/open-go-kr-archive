---
name: open-go-kr-collect
description: "open.go.kr 원문정보 자동 수집기 Python 코어를 구현하는 스킬. 목록 조회 API, HTML 파싱 상세 조회, 3단계 파일 다운로드, 공개여부 판단 로직, CLI 인터페이스, Supabase 동기화를 포함. '원문공개 수집기', '정보공개포털 크롤러', 'open.go.kr 다운로드', '원문정보 수집 Python' 등의 요청 시 반드시 이 스킬을 사용할 것."
---

# open.go.kr 원문정보 수집기 구현

open.go.kr 정보공개포털에서 원문정보를 자동 수집하는 Python CLI 프로그램을 구현한다.

## 기술 스택

- Python 3.8+
- requests (HTTP 클라이언트, Session으로 쿠키 유지)
- tqdm (진행 표시)
- supabase-py (선택, Supabase 동기화)

## 프로젝트 구조

```
collector/
├── open_go_kr_collector.py   # 메인 수집기 (단일 파일 실행)
├── supabase_sync.py          # Supabase 동기화 모듈
├── requirements.txt          # 의존성
└── .env.example              # 환경변수 템플릿
```

## 구현 순서

### 1. 세션 및 헤더 설정

requests.Session()을 사용하여 쿠키를 유지한다. open.go.kr은 세션 쿠키 기반으로 동작하므로, 첫 GET 요청으로 쿠키를 획득한 뒤 이후 모든 요청에 사용한다.

```python
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 ...',
    'Referer': 'https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do',
})
# 초기 쿠키 획득
session.get('https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do', timeout=30)
```

### 2. 목록 조회

POST API로 검색 조건에 맞는 문서 목록을 페이지네이션하며 수집한다. 페이지당 최대 50건. `rtnTotal`로 전체 건수를 파악하고 `max_count`까지 수집한다.

### 3. 상세 조회 (HTML 파싱)

GET 요청으로 상세 페이지를 받고, HTML 내 JavaScript에서 정규식으로 `result` 객체를 추출한다. JSON5 형태이므로 `json.loads` 전에 JavaScript 특수 구문(trailing comma, 작은따옴표)을 처리해야 한다.

추출 패턴: `r'var result = ({[\s\S]*?});\s*var currViewPage'`

html.unescape()로 HTML 엔티티를 디코딩한다.

### 4. 파일 다운로드 3단계

API 명세는 `references/api-spec.md`를 참조한다. 3단계 요청의 파라미터 매핑이 복잡하므로 정확히 따른다.

핵심 매핑:
- Step 1 입력의 `esbFileName` = 상세조회의 `fileNm`
- Step 1 입력의 `docId` = 상세조회의 `docNo`
- Step 1 입력의 `ctDate` = 상세조회의 `prdnDt`
- Step 1 입력의 `orgCd` = 상세조회의 `nstCd`

### 5. 공개 여부 판단

`can_download()` 함수로 각 파일의 다운로드 가능 여부를 판단한다. `references/api-spec.md`의 판단 로직을 정확히 구현한다.

### 6. 출력 구조

```
output_dir/
├── collection_log.csv
├── 1_{문서제목}/
│   ├── metadata.md
│   └── 본문_결재문서본문.pdf
├── 2_{문서제목}/
│   ├── metadata.md
│   ├── 본문_결재문서본문.pdf
│   └── 첨부_홍보문.png
└── ...
```

폴더명: `{순번}_{제목 앞 40자}` — 불가 문자(\/:*?"<>|[]「」)는 `_`로 치환
파일명: `{fileSeDc}_{원본파일명}` (예: `본문_결재문서본문.pdf`)

### 7. metadata.md 형식

```markdown
# {문서 제목}

## 메타데이터

| 항목 | 내용 |
|------|------|
| 제목 | ... |
| 문서번호 | ... |
| 기관명 | ... |
| 담당부서 | ... |
| 담당자 | ... |
| 생산일자 | YYYY.MM.DD |
| 보존기간 | ... |
| 단위업무 | ... |
| 공개여부 | 공개/부분공개/비공개 |
| 분류체계 | A > B > C |
| 원문등록번호 | ... |
| 열람제한일 | YYYY.MM.DD |

## 파일 목록

- **본문**: 결재문서본문.pdf (45.6 KB) [공개]

## 원문 링크

https://www.open.go.kr/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=...
```

### 8. collection_log.csv

```
번호,원문등록번호,제목,처리시각,상태,다운로드파일수,비고
```

### 9. Resume 기능

기존 출력 폴더에 해당 문서의 하위 폴더가 이미 있으면 건너뛴다. collection_log.csv도 이미 기록된 원문등록번호는 건너뛴다.

### 10. Supabase 동기화

`supabase_sync.py` 모듈로 수집된 메타데이터를 Supabase에 업서트한다. 환경변수 `SUPABASE_URL`과 `SUPABASE_SERVICE_KEY`가 설정된 경우에만 동작한다. 미설정 시 경고 출력 후 로컬 저장만 수행한다.

## 안정성 요건

| 항목 | 기준 |
|------|------|
| 요청 간 딜레이 | 최소 1초 (기본값) |
| 최대 재시도 횟수 | 3회 (지수 백오프: 2, 4, 8초) |
| 타임아웃 | 30초 |
| 세션 관리 | requests.Session()으로 쿠키 유지 |
| 재시작 기능 | 기존 처리된 폴더는 건너뜀 |

## 제약사항

- open.go.kr 이용약관 준수: 과도한 자동 요청 금지
- 비공개/열람제한 문서의 강제 접근 시도 금지
- 개인정보 포함 문서 처리 시 관련 법령 준수
