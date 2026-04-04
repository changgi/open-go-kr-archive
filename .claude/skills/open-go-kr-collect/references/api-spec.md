# open.go.kr API 명세

## 목차

1. [목록 조회 API](#1-목록-조회-api)
2. [상세 조회 (HTML 파싱)](#2-상세-조회)
3. [파일 다운로드 3단계](#3-파일-다운로드-3단계)
4. [공개 여부 판단 로직](#4-공개-여부-판단-로직)
5. [CLI 인수](#5-cli-인수)

---

## 1. 목록 조회 API

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

## 2. 상세 조회

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

## 3. 파일 다운로드 3단계

### Step 1 — 파일 전송 요청

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

### Step 2 — 개인정보 필터링

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

### Step 3 — 파일 다운로드

```
POST /util/wonmunUtils/wonmunFileDownload.down

입력:
  esbFilePath, esbFileName, fileName, isPdf
  prdnNstRgstNo, prdnDt, fileId, gubun=esbFilePath

응답: 파일 바이너리 (application/octet-stream)
```

## 4. 공개 여부 판단 로직

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

| oppSeCd | 의미 | 다운로드 가능 여부 |
|---------|------|-----------------|
| 1 | 공개 | 모든 파일 가능 |
| 2 | 부분공개 | fileOppYn = Y 인 파일만 가능 |
| 3 | 비공개 | 불가 |
| 5 | 열람제한 | dtaRedgLmttEndYmd > 오늘이면 불가 |
| (공통) | urtxtYn = N | 국장급 이상 전용, 불가 |

## 5. CLI 인수

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
| --supabase-url | | env | Supabase URL |
| --supabase-key | | env | Supabase 서비스 키 |
