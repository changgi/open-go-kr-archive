# open.go.kr 원문정보 자동 수집기

> **버전**: 1.0.0 | **작성일**: 2026-04-04

---

## 목차

1. [PRD (Product Requirements Document)](#prd)
   - [개요](#개요)
   - [기능 요건](#기능-요건)
   - [기술 요건](#기술-요건)
   - [출력 구조](#출력-구조)
   - [제약사항](#제약사항)
2. [개발용 프롬프트](#개발용-프롬프트)
   - [System Prompt](#system-prompt)
   - [User Prompt](#user-prompt)

---

# PRD

## 개요

### 목적

대한민국 정보공개포털(open.go.kr)의 원문정보 시스템에서 공개된 문서의 메타데이터와 파일을 자동으로 수집하여 로컬 파일시스템에 체계적으로 정리하는 프로그램을 개발한다.

### 배경

open.go.kr은 112만 건 이상의 원문정보를 공개하고 있으나, 수동으로 개별 접근하는 방식으로는 대량 수집이 불가능하다. 연구자, 언론인, 데이터 분석가 등이 특정 조건에 해당하는 문서를 일괄 수집할 수 있는 도구가 필요하다.

---

## 기능 요건

### F-01: 목록 수집

- 검색 조건(키워드, 기관, 날짜, 공개구분)을 지정해 대상 문서 목록을 API로 수집한다.
- 페이지네이션을 자동 처리하여 설정한 최대 건수까지 수집한다.
- 수집 속도를 요청 간 딜레이로 제어하여 서버 부하를 방지한다.

### F-02: 메타데이터 추출

각 문서의 상세 페이지에서 구조화된 메타데이터를 추출하여 Markdown 표 형식의 `.md` 파일로 저장한다.

추출 항목:

| 필드 | 설명 |
|------|------|
| 제목 | 문서 제목 |
| 문서번호 | 기관 내부 문서번호 |
| 기관명 | 처리기관명 |
| 담당부서 | 담당 부서명 |
| 담당자 | 담당자 이름 |
| 생산일자 | 문서 생산일 (YYYY.MM.DD) |
| 보존기간 | 문서 보존 기간 |
| 단위업무 | 업무 분류 |
| 공개여부 | 공개 / 부분공개 / 비공개 / 열람제한 |
| 분류체계 | 계층형 업무 분류 경로 |
| 원문등록번호 | 시스템 등록번호 (prdnNstRgstNo) |
| 열람제한일 | 열람 가능 시작일 |

### F-03: 파일 다운로드

공개된 파일을 3단계 API 프로세스를 통해 다운로드한다.

```
Step 1. wonmunFileRequest.ajax   → 파일 전송 요청
Step 2. wonmunFileFilter.ajax    → 개인정보 필터링 처리
Step 3. wonmunFileDownload.down  → 실제 파일 바이너리 수신
```

다운로드 판단 기준:

| oppSeCd | 의미 | 다운로드 가능 여부 |
|---------|------|-----------------|
| 1 | 공개 | 모든 파일 가능 |
| 2 | 부분공개 | fileOppYn = Y 인 파일만 가능 |
| 3 | 비공개 | 불가 |
| 5 | 열람제한 | dtaRedgLmttEndYmd > 오늘이면 불가 |
| (공통) | urtxtYn = N | 국장급 이상 전용, 불가 |

### F-04: 폴더 구조 생성

- 베이스 폴더 아래 문서별 하위 폴더를 자동 생성한다.
- 폴더 이름 형식: `{순번}_{제목 앞 40자}` (파일시스템 불가 문자는 `_`로 치환)
- 파일 저장 이름 형식: `{fileSeDc}_{원본파일명}` (예: `본문_결재문서본문.pdf`)

### F-05: ZIP 아카이브

수집된 전체 폴더를 단일 ZIP 파일로 압축 저장하는 옵션을 제공한다.

### F-06: 수집 로그

각 문서의 처리 결과를 `collection_log.csv` 로그 파일로 기록한다.

로그 컬럼: `번호`, `원문등록번호`, `제목`, `처리시각`, `상태`, `다운로드파일수`, `비고`

---

## 기술 요건

### API 명세

#### 목록 조회 API

```
POST https://www.open.go.kr/othicInfo/infoList/orginlInfoList.ajax
Content-Type: application/x-www-form-urlencoded

파라미터:
  kwd          : 검색어 (빈 문자열 가능)
  startDate    : YYYYMMDD
  endDate      : YYYYMMDD
  insttCd      : 기관코드 (빈 문자열 = 전체)
  insttSeCd    : 기관구분 (빈 문자열 = 전체)
  othbcSeCd    : 공개구분 (빈=전체, 1=공개, 2=부분공개)
  viewPage     : 페이지 번호 (1부터 시작)
  rowPage      : 페이지당 건수 (10~50)
  sort         : 정렬 (d=날짜순, j=제목순)

응답 JSON:
  rtnTotal     : 전체 건수
  rtnList[]    : 문서 목록
    PRDCTN_INSTT_REGIST_NO  : 원문등록번호
    PRDCTN_DT               : 생산일시 (YYYYMMDDHHmmss)
    INSTT_SE_CD             : 기관구분코드
    INFO_SJ                 : 제목
    DOC_NO                  : 문서번호
    NFLST_CHRG_DEPT_NM      : 소속 기관/부서 전체명
    PROC_INSTT_NM           : 처리기관명
    UNIT_JOB_NM             : 단위업무
    CHRG_DEPT_NM            : 담당부서
    CHARGER_NM              : 담당자
    P_DATE                  : 생산일자 (YYYYMMDD)
    FILE_NM                 : 파일명 목록 (파이프로 구분)
    OTHBC_SE_CD             : 공개구분
    INSTT_CD                : 기관코드
    RQEST_TY_THEMA_NM       : 분류체계
    tma_kwd                 : 키워드 (개행으로 구분)
```

#### 상세 조회 (HTML 파싱)

```
GET https://www.open.go.kr/othicInfo/infoList/infoListDetl.do
파라미터: prdnNstRgstNo, prdnDt, nstSeCd, title=원문정보, rowPage=10, viewPage=1

HTML 내 JavaScript에서 정규식으로 추출:
  패턴: /var result = ({[\s\S]*?});\s*var currViewPage/

result.openCateSearchVO 필드:
  infoSj, docNo, prcsNstNm, chrgDeptNm, chgrNmpn
  prdnDt, prsrvPdCd, unitJobNm, oppSeCd, dlsrCdNm
  nstClNm, dtaRedgLmttEndYmd, fileYn, urtxtYn
  nstCd, chrgDeptCd

  fileList[]:
    fileId      : 파일 고유 ID
    fileNm      : 파일명
    fileSeDc    : 구분 (본문 / 첨부)
    fileByteNum : 파일 크기 (bytes)
    fileOppYn   : 공개 여부 (Y/N)
```

#### 파일 다운로드 3단계 API

**Step 1 — 파일 전송 요청**

```
POST /util/wonmunUtils/wonmunFileRequest.ajax

입력:
  fileId, esbFileName(=fileNm), docId(=docNo)
  ctDate(=prdnDt), orgCd(=nstCd), prdnNstRgstNo
  oppSeCd, isPdf(N or Y), chrgDeptNm

응답:
  esbFilePath    : 서버 내 파일 경로
  esbFileName    : 서버 내 파일명
  fileName       : 실제 저장 파일명
  orglPrdnNstCd  : 원기관코드
  mngrTelno      : 담당자 전화번호
  orginlFileVO.closegvrnYn : 비밀문서 여부
```

**Step 2 — 개인정보 필터링**

```
POST /util/wonmunUtils/wonmunFileFilter.ajax

입력:
  prdnNstRgstNo, prdnDt(=ctDate)
  esbFilePath, esbFileName, fileName
  fileId, orglPrdnNstCd, nstCd, orgCd, orgSeCd(=nstSeCd or E)
  infoSj, chgrNmpn, orgNm(=prcsNstNm)
  chrgDeptCd, chrgDeptNm, nstClNm, prsrvPdCd
  docId(=docNo), isPdf, step=step2
  closegvrnYn, ndnfFiltrRndabtYn=N
  rceptInsttCd, rceptInsttCdNm, mngrTelno

응답:
  esbFilePath, esbFileName, fileName, isPdf
```

**Step 3 — 파일 다운로드**

```
POST /util/wonmunUtils/wonmunFileDownload.down

입력:
  esbFilePath, esbFileName, fileName, isPdf
  prdnNstRgstNo, prdnDt, fileId, gubun=esbFilePath

응답: 파일 바이너리 (application/octet-stream)
```

### 성능 및 안정성 요건

| 항목 | 기준 |
|------|------|
| 요청 간 딜레이 | 최소 1초 (기본값) |
| 최대 재시도 횟수 | 3회 (지수 백오프) |
| 타임아웃 | 30초 |
| 세션 관리 | requests.Session() 으로 쿠키 유지 |
| 재시작 기능 | 기존 처리된 폴더는 건너뜀 (resume) |

---

## 출력 구조

### 폴더 트리

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

### metadata.md 형식

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
- **첨부**: 운영계획.hwp (1.7 MB) [비공개/제한]

## 원문 링크

https://www.open.go.kr/othicInfo/infoList/infoListDetl.do?prdnNstRgstNo=...
```

### collection_log.csv 형식

```
번호,원문등록번호,제목,처리시각,상태,다운로드파일수,비고
1,B10CB260929212541000,"[카드] 웹툰작가 운영물품...",2026-04-04 00:01:44,ok,1,
2,J10CB260907027422000,"2026 경기연천교권보호...",2026-04-04 00:01:46,skipped,0,열람제한(9999.12.31)
```

---

## 제약사항

- open.go.kr 이용약관 준수: 과도한 자동 요청 금지 (요청 간 딜레이 필수)
- 비공개/열람제한 문서의 강제 접근 시도 금지
- 개인정보 포함 문서 처리 시 관련 법령(개인정보보호법) 준수
- 수집된 공공데이터는 공공데이터 이용조건(KOGL) 준수

---

---

# 개발용 프롬프트

## System Prompt

```
당신은 Python 전문 개발자입니다. 공공 API를 이용한 데이터 수집 프로그램을 작성합니다.
코드는 명확한 주석과 함께 읽기 쉽게 작성하고, 에러 처리를 철저히 합니다.
```

## User Prompt

```
대한민국 정보공개포털(open.go.kr)에서 원문정보를 자동 수집하는 Python CLI 프로그램을 작성해줘.

## 수집 대상 사이트

- URL: https://www.open.go.kr/othicInfo/infoList/orginlInfoList.do
- 세션 쿠키 기반 인증 (비로그인 상태로 공개 문서만 수집)

## 사용할 API 엔드포인트 (모두 POST, form-urlencoded)

### 1. 목록 조회

POST /othicInfo/infoList/orginlInfoList.ajax
파라미터:
  kwd       : 검색어 (빈 문자열 가능)
  startDate : YYYYMMDD
  endDate   : YYYYMMDD
  insttCd   : 기관코드 (빈 문자열=전체)
  insttSeCd : 기관구분 (빈 문자열=전체)
  othbcSeCd : 공개구분 (빈=전체, 1=공개, 2=부분공개)
  viewPage  : 페이지 번호 (1부터 시작)
  rowPage   : 페이지당 건수 (10~50)
  sort      : 정렬 (d=날짜순)

응답 JSON:
  rtnTotal  : 전체 건수
  rtnList[] : 아래 필드 포함
    PRDCTN_INSTT_REGIST_NO  원문등록번호
    PRDCTN_DT               생산일시 (YYYYMMDDHHmmss)
    INSTT_SE_CD             기관구분코드
    INFO_SJ                 제목
    DOC_NO                  문서번호
    NFLST_CHRG_DEPT_NM      소속 기관/부서 전체명
    PROC_INSTT_NM           처리기관명
    UNIT_JOB_NM             단위업무
    CHRG_DEPT_NM            담당부서
    CHARGER_NM              담당자
    P_DATE                  생산일자 (YYYYMMDD)
    FILE_NM                 파일명 목록 (파이프 구분)
    OTHBC_SE_CD             공개구분
    INSTT_CD                기관코드
    RQEST_TY_THEMA_NM       분류체계
    tma_kwd                 키워드 (개행 구분)

### 2. 상세 조회 (HTML 파싱)

GET /othicInfo/infoList/infoListDetl.do
파라미터: prdnNstRgstNo, prdnDt, nstSeCd, title=원문정보, rowPage=10, viewPage=1

HTML 내 JavaScript 정규식 추출 패턴:
  r'var result = ({[\s\S]*?});\s*var currViewPage'

result.openCateSearchVO 주요 필드:
  infoSj, docNo, prcsNstNm, chrgDeptNm, chgrNmpn, prdnDt
  prsrvPdCd, unitJobNm, oppSeCd, dlsrCdNm, nstClNm
  dtaRedgLmttEndYmd, fileYn, urtxtYn, nstCd, chrgDeptCd

  fileList[]:
    fileId      파일 고유 ID
    fileNm      파일명
    fileSeDc    구분 (본문/첨부)
    fileByteNum 파일 크기 (bytes)
    fileOppYn   공개 여부 (Y/N)

### 3. 파일 다운로드 3단계

[Step 1] POST /util/wonmunUtils/wonmunFileRequest.ajax
입력: fileId, esbFileName(=fileNm), docId(=docNo), ctDate(=prdnDt),
      orgCd(=nstCd), prdnNstRgstNo, oppSeCd, isPdf(N or Y), chrgDeptNm
응답: esbFilePath, esbFileName, fileName,
      orglPrdnNstCd, mngrTelno, orginlFileVO.closegvrnYn

[Step 2] POST /util/wonmunUtils/wonmunFileFilter.ajax
입력: prdnNstRgstNo, prdnDt(=ctDate), esbFilePath, esbFileName, fileName,
      fileId, orglPrdnNstCd, nstCd, orgCd, orgSeCd(=nstSeCd or E),
      infoSj, chgrNmpn, orgNm(=prcsNstNm), chrgDeptCd, chrgDeptNm,
      nstClNm, prsrvPdCd, docId(=docNo), isPdf, step=step2,
      closegvrnYn, ndnfFiltrRndabtYn=N, rceptInsttCd, rceptInsttCdNm, mngrTelno
응답: esbFilePath, esbFileName, fileName, isPdf

[Step 3] POST /util/wonmunUtils/wonmunFileDownload.down
입력: esbFilePath, esbFileName, fileName, isPdf,
      prdnNstRgstNo, prdnDt, fileId, gubun=esbFilePath
응답: 파일 바이너리

## 공개 여부 판단 로직

```python
def can_download(opp_se_cd, file_opp_yn, urtxt_yn, dta_redg_lmtt_end_ymd, today):
    if urtxt_yn == 'N':
        return False, '국장급 이상 전용'
    if opp_se_cd == '3':
        return False, '비공개'
    if opp_se_cd == '5' and dta_redg_lmtt_end_ymd > today:
        return False, f'열람제한({dta_redg_lmtt_end_ymd})'
    if opp_se_cd == '1':
        return True, ''
    if opp_se_cd == '2' and file_opp_yn == 'Y':
        return True, ''
    return False, '부분공개(비공개 파일)'
```

## CLI 인수 (argparse)

| 인수 | 단축 | 기본값 | 설명 |
|------|------|--------|------|
| --keyword | -k | (없음) | 검색어 |
| --start-date | -s | 오늘-30일 | 시작일 (YYYY-MM-DD) |
| --end-date | -e | 오늘 | 종료일 (YYYY-MM-DD) |
| --instt-cd | | (전체) | 기관코드 |
| --instt-se-cd | | (전체) | 기관구분 |
| --othbc-se-cd | | (전체) | 공개구분 |
| --max-count | -n | 10 | 최대 수집 건수 |
| --output-dir | -o | ./open_go_kr_docs | 출력 폴더 |
| --delay | -d | 1.0 | 요청 간 딜레이(초) |
| --skip-files | | False | 파일 다운로드 건너뜀 |
| --zip | | False | 완료 후 ZIP 압축 |

## 실행 예시

```bash
# 기본 실행 (최근 30일, 10건)
python open_go_kr_collector.py

# 키워드 검색, 50건 수집, ZIP 압축
python open_go_kr_collector.py -k "운영계획" -n 50 --zip

# 특정 기관, 날짜 범위, 출력 폴더 지정
python open_go_kr_collector.py --instt-cd 7010000 -s 2026-01-01 -e 2026-04-04 -o ./seoul_edu -n 100

# 메타데이터만 수집 (파일 다운로드 없음)
python open_go_kr_collector.py -n 200 --skip-files
```

## 프로그램 구현 요건

- Python 3.8+, requests 라이브러리 사용 (pip install requests tqdm)
- requests.Session()으로 쿠키 유지
- 요청 헤더에 User-Agent, Referer 포함
- HTML 엔티티 디코딩 (html.unescape 사용)
- HTTP 에러 시 최대 3회 재시도 (지수 백오프: 2, 4, 8초)
- 타임아웃 30초
- tqdm으로 진행 상황 실시간 표시
- collection_log.csv에 처리 결과 기록
- 기존 출력 폴더에 파일가 있으면 건너뜀 (resume 기능)
- 폴더명 불가 문자 치환: \ / : * ? " < > | [ ] 「 」 → _
- 모든 파일 UTF-8 인코딩

전체 실행 가능한 Python 파일 1개로 작성해줘.
```
