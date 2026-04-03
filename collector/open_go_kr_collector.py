#!/usr/bin/env python3
"""
open.go.kr 원문정보 자동 수집기
- 목록 조회 → 상세 조회(HTML 파싱) → 3단계 파일 다운로드
- 로컬 파일 저장 + Supabase 동기화(선택)
"""
import argparse
import csv
import html
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from tqdm import tqdm

try:
    from supabase_sync import SupabaseSync
except ImportError:
    SupabaseSync = None

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE_URL = "https://www.open.go.kr"
LIST_URL = f"{BASE_URL}/othicInfo/infoList/orginlInfoList.ajax"
DETAIL_URL = f"{BASE_URL}/othicInfo/infoList/infoListDetl.do"
FILE_REQUEST_URL = f"{BASE_URL}/util/wonmunUtils/wonmunFileRequest.ajax"
FILE_FILTER_URL = f"{BASE_URL}/util/wonmunUtils/wonmunFileFilter.ajax"
FILE_DOWNLOAD_URL = f"{BASE_URL}/util/wonmunUtils/wonmunFileDownload.down"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": f"{BASE_URL}/othicInfo/infoList/orginlInfoList.do",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
}

TIMEOUT = 30
MAX_RETRIES = 3
BACKOFF_SECONDS = [2, 4, 8]
INVALID_CHARS_RE = re.compile(r'[\\/:*?"<>|\[\]「」]')

OPP_SE_LABELS = {"1": "공개", "2": "부분공개", "3": "비공개", "5": "열람제한"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sanitize_filename(name: str, max_len: int = 40) -> str:
    name = html.unescape(name).strip()
    name = INVALID_CHARS_RE.sub("_", name)
    return name[:max_len]


def can_download(
    opp_se_cd: str,
    file_opp_yn: str,
    urtxt_yn: str,
    dta_redg_lmtt_end_ymd: str,
    today: str,
) -> Tuple[bool, str]:
    if urtxt_yn == "N":
        return False, "국장급 이상 전용"
    if opp_se_cd == "3":
        return False, "비공개"
    if opp_se_cd == "5" and dta_redg_lmtt_end_ymd > today:
        return False, f"열람제한({dta_redg_lmtt_end_ymd})"
    if opp_se_cd == "1":
        return True, ""
    if opp_se_cd == "2" and file_opp_yn == "Y":
        return True, ""
    return False, "부분공개(비공개 파일)"


def format_date_dot(yyyymmdd: str) -> str:
    if len(yyyymmdd) == 8:
        return f"{yyyymmdd[:4]}.{yyyymmdd[4:6]}.{yyyymmdd[6:]}"
    return yyyymmdd


def format_file_size(byte_num: Any) -> str:
    try:
        b = int(byte_num)
    except (ValueError, TypeError):
        return "? KB"
    if b < 1024:
        return f"{b} B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f} KB"
    return f"{b / (1024 * 1024):.1f} MB"


# ---------------------------------------------------------------------------
# Collector
# ---------------------------------------------------------------------------

class OpenGoKrCollector:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.output_dir = Path(args.output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.today = datetime.now().strftime("%Y%m%d")
        self.log_rows: List[List[str]] = []
        self.supabase: Optional[Any] = None
        self._init_supabase()

    # -- Supabase ----------------------------------------------------------

    def _init_supabase(self):
        url = self.args.supabase_url or os.getenv("SUPABASE_URL", "")
        key = self.args.supabase_key or os.getenv("SUPABASE_SERVICE_KEY", "")
        if url and key and SupabaseSync is not None:
            try:
                self.supabase = SupabaseSync(url, key)
                print("[Supabase] 연결 성공")
            except Exception as e:
                print(f"[Supabase] 연결 실패 (로컬만 저장): {e}")

    # -- HTTP helpers ------------------------------------------------------

    def _post(self, url: str, data: dict, **kwargs) -> requests.Response:
        return self._request("POST", url, data=data, **kwargs)

    def _get(self, url: str, params: dict = None, **kwargs) -> requests.Response:
        return self._request("GET", url, params=params, **kwargs)

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        kwargs.setdefault("timeout", TIMEOUT)
        for attempt in range(MAX_RETRIES):
            try:
                resp = self.session.request(method, url, **kwargs)
                resp.raise_for_status()
                return resp
            except requests.RequestException as e:
                if attempt < MAX_RETRIES - 1:
                    wait = BACKOFF_SECONDS[attempt]
                    print(f"  [재시도 {attempt + 1}/{MAX_RETRIES}] {e} — {wait}초 대기")
                    time.sleep(wait)
                else:
                    raise

    # -- 1) 목록 조회 ------------------------------------------------------

    def fetch_list(self, page: int = 1, row_page: int = 10) -> dict:
        data = {
            "kwd": self.args.keyword or "",
            "startDate": self.args.start_date,
            "endDate": self.args.end_date,
            "insttCd": self.args.instt_cd or "",
            "insttSeCd": self.args.instt_se_cd or "",
            "othbcSeCd": self.args.othbc_se_cd or "",
            "viewPage": page,
            "rowPage": row_page,
            "sort": "d",
        }
        resp = self._post(LIST_URL, data=data)
        return resp.json()

    # -- 2) 상세 조회 (HTML 파싱) ------------------------------------------

    def fetch_detail(self, item: dict) -> Optional[dict]:
        params = {
            "prdnNstRgstNo": item["PRDCTN_INSTT_REGIST_NO"],
            "prdnDt": item["PRDCTN_DT"],
            "nstSeCd": item["INSTT_SE_CD"],
            "title": "원문정보",
            "rowPage": 10,
            "viewPage": 1,
        }
        resp = self._get(DETAIL_URL, params=params)
        resp.encoding = "utf-8"
        text = resp.text

        m = re.search(r"var result = ({[\s\S]*?});\s*var currViewPage", text)
        if not m:
            return None

        raw = m.group(1)
        raw = re.sub(r"(\w+)\s*:", r'"\1":', raw)
        raw = raw.replace("'", '"')
        raw = re.sub(r",\s*([}\]])", r"\1", raw)

        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            return None

        return result

    # -- 3) 파일 다운로드 3단계 --------------------------------------------

    def download_file(self, file_info: dict, detail_vo: dict, dest_dir: Path) -> Optional[Path]:
        file_id = file_info.get("fileId", "")
        file_nm = file_info.get("fileNm", "")
        file_se_dc = file_info.get("fileSeDc", "")
        doc_no = detail_vo.get("docNo", "")
        prdn_dt = detail_vo.get("prdnDt", "")
        nst_cd = detail_vo.get("nstCd", "")
        prdn_nst_rgst_no = detail_vo.get("prdnNstRgstNo", "") or detail_vo.get("prdctnInsttRegistNo", "")
        opp_se_cd = detail_vo.get("oppSeCd", "")
        chrg_dept_nm = detail_vo.get("chrgDeptNm", "")

        # Step 1: wonmunFileRequest
        step1_data = {
            "fileId": file_id,
            "esbFileName": file_nm,
            "docId": doc_no,
            "ctDate": prdn_dt,
            "orgCd": nst_cd,
            "prdnNstRgstNo": prdn_nst_rgst_no,
            "oppSeCd": opp_se_cd,
            "isPdf": "N",
            "chrgDeptNm": chrg_dept_nm,
        }
        try:
            resp1 = self._post(FILE_REQUEST_URL, data=step1_data)
            r1 = resp1.json()
        except Exception as e:
            print(f"    [Step1 실패] {e}")
            return None

        esb_file_path = r1.get("esbFilePath", "")
        esb_file_name = r1.get("esbFileName", "")
        file_name = r1.get("fileName", "")
        orgl_prdn_nst_cd = r1.get("orglPrdnNstCd", "")
        mngr_telno = r1.get("mngrTelno", "")
        closegvrn_yn = "N"
        orginl_file_vo = r1.get("orginlFileVO", {})
        if isinstance(orginl_file_vo, dict):
            closegvrn_yn = orginl_file_vo.get("closegvrnYn", "N")
        is_pdf = r1.get("isPdf", "N")

        # Step 2: wonmunFileFilter
        nst_se_cd = detail_vo.get("nstSeCd", "") or detail_vo.get("insttSeCd", "")
        org_se_cd = nst_se_cd if nst_se_cd else "E"

        step2_data = {
            "prdnNstRgstNo": prdn_nst_rgst_no,
            "prdnDt": prdn_dt,
            "esbFilePath": esb_file_path,
            "esbFileName": esb_file_name,
            "fileName": file_name,
            "fileId": file_id,
            "orglPrdnNstCd": orgl_prdn_nst_cd,
            "nstCd": nst_cd,
            "orgCd": nst_cd,
            "orgSeCd": org_se_cd,
            "infoSj": detail_vo.get("infoSj", ""),
            "chgrNmpn": detail_vo.get("chgrNmpn", ""),
            "orgNm": detail_vo.get("prcsNstNm", ""),
            "chrgDeptCd": detail_vo.get("chrgDeptCd", ""),
            "chrgDeptNm": chrg_dept_nm,
            "nstClNm": detail_vo.get("nstClNm", ""),
            "prsrvPdCd": detail_vo.get("prsrvPdCd", ""),
            "docId": doc_no,
            "isPdf": is_pdf,
            "step": "step2",
            "closegvrnYn": closegvrn_yn,
            "ndnfFiltrRndabtYn": "N",
            "rceptInsttCd": "",
            "rceptInsttCdNm": "",
            "mngrTelno": mngr_telno,
        }
        try:
            resp2 = self._post(FILE_FILTER_URL, data=step2_data)
            r2 = resp2.json()
        except Exception as e:
            print(f"    [Step2 실패] {e}")
            return None

        esb_file_path = r2.get("esbFilePath", esb_file_path)
        esb_file_name = r2.get("esbFileName", esb_file_name)
        file_name = r2.get("fileName", file_name)
        is_pdf = r2.get("isPdf", is_pdf)

        # Step 3: wonmunFileDownload
        step3_data = {
            "esbFilePath": esb_file_path,
            "esbFileName": esb_file_name,
            "fileName": file_name,
            "isPdf": is_pdf,
            "prdnNstRgstNo": prdn_nst_rgst_no,
            "prdnDt": prdn_dt,
            "fileId": file_id,
            "gubun": esb_file_path,
        }
        try:
            resp3 = self._post(FILE_DOWNLOAD_URL, data=step3_data, stream=True)
        except Exception as e:
            print(f"    [Step3 실패] {e}")
            return None

        safe_se = sanitize_filename(file_se_dc, 20) if file_se_dc else "첨부"
        safe_nm = sanitize_filename(file_nm, 80) if file_nm else file_name
        out_name = f"{safe_se}_{safe_nm}"
        out_path = dest_dir / out_name
        with open(out_path, "wb") as f:
            for chunk in resp3.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return out_path

    # -- metadata.md -------------------------------------------------------

    def write_metadata(self, dest_dir: Path, detail_vo: dict, file_list: list, prdn_nst_rgst_no: str):
        opp_se_cd = detail_vo.get("oppSeCd", "")
        opp_label = OPP_SE_LABELS.get(opp_se_cd, opp_se_cd)
        rqest_ty_thema = detail_vo.get("rqestTyThemaNm", "") or detail_vo.get("dlsrCdNm", "")

        lines = [
            f"# {html.unescape(detail_vo.get('infoSj', ''))}",
            "",
            "## 메타데이터",
            "",
            "| 항목 | 내용 |",
            "|------|------|",
            f"| 제목 | {html.unescape(detail_vo.get('infoSj', ''))} |",
            f"| 문서번호 | {detail_vo.get('docNo', '')} |",
            f"| 기관명 | {detail_vo.get('prcsNstNm', '')} |",
            f"| 담당부서 | {detail_vo.get('chrgDeptNm', '')} |",
            f"| 담당자 | {detail_vo.get('chgrNmpn', '')} |",
            f"| 생산일자 | {format_date_dot(detail_vo.get('prdnDt', ''))} |",
            f"| 보존기간 | {detail_vo.get('prsrvPdCd', '')} |",
            f"| 단위업무 | {detail_vo.get('unitJobNm', '')} |",
            f"| 공개여부 | {opp_label} |",
            f"| 분류체계 | {rqest_ty_thema} |",
            f"| 원문등록번호 | {prdn_nst_rgst_no} |",
            f"| 열람제한일 | {format_date_dot(detail_vo.get('dtaRedgLmttEndYmd', ''))} |",
            "",
            "## 파일 목록",
        ]

        for f in file_list:
            fname = f.get("fileNm", "")
            fsize = format_file_size(f.get("fileByteNum", 0))
            fopp = "[공개]" if f.get("fileOppYn", "") == "Y" else "[비공개]"
            fse = f.get("fileSeDc", "")
            lines.append(f"- **{fse}**: {fname} ({fsize}) {fopp}")

        prdn_dt = detail_vo.get("prdnDt", "")
        nst_se_cd = detail_vo.get("nstSeCd", "") or detail_vo.get("insttSeCd", "")
        link = (
            f"{DETAIL_URL}?prdnNstRgstNo={prdn_nst_rgst_no}"
            f"&prdnDt={prdn_dt}&nstSeCd={nst_se_cd}"
        )
        lines += ["", "## 원문 링크", link, ""]

        (dest_dir / "metadata.md").write_text("\n".join(lines), encoding="utf-8")

    # -- CSV 로그 ----------------------------------------------------------

    def _init_log_csv(self):
        csv_path = self.output_dir / "collection_log.csv"
        if not csv_path.exists():
            with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["번호", "원문등록번호", "제목", "처리시각", "상태", "다운로드파일수", "비고"])

    def _append_log(self, idx: int, reg_no: str, title: str, status: str, dl_count: int, note: str):
        row = [idx, reg_no, title, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), status, dl_count, note]
        self.log_rows.append(row)
        csv_path = self.output_dir / "collection_log.csv"
        with open(csv_path, "a", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerow(row)

    # -- 메인 실행 ---------------------------------------------------------

    def run(self):
        keyword = self.args.keyword or ""
        print(f"[수집 시작] 키워드='{keyword}' "
              f"기간={self.args.start_date}~{self.args.end_date} "
              f"최대={self.args.max_count}건")

        self._init_log_csv()

        # 1) 목록 조회
        row_page = min(self.args.max_count, 50)
        first_page = self.fetch_list(page=1, row_page=row_page)
        total = int(first_page.get("rtnTotal", 0))
        items = first_page.get("rtnList", [])
        print(f"[목록] 전체 {total}건 조회됨")

        if total == 0:
            print("[완료] 검색 결과 없음")
            return

        # Supabase: 수집 실행 기록 시작
        run_id = None
        if self.supabase:
            try:
                run_id = self.supabase.start_run(
                    keyword, self.args.start_date, self.args.end_date, total
                )
            except Exception as e:
                print(f"[Supabase] start_run 실패 (로컬 계속): {e}")

        # 추가 페이지 조회
        max_count = self.args.max_count
        page = 2
        while len(items) < max_count and len(items) < total:
            time.sleep(self.args.delay)
            page_data = self.fetch_list(page=page, row_page=row_page)
            new_items = page_data.get("rtnList", [])
            if not new_items:
                break
            items.extend(new_items)
            page += 1

        items = items[:max_count]
        print(f"[처리 대상] {len(items)}건")

        # 2) 각 문서 처리
        collected_count = 0
        for idx, item in enumerate(tqdm(items, desc="수집 중"), start=1):
            reg_no = item.get("PRDCTN_INSTT_REGIST_NO", "")
            title_raw = html.unescape(item.get("INFO_SJ", ""))
            folder_name = f"{idx}_{sanitize_filename(title_raw)}"
            dest_dir = self.output_dir / folder_name

            # resume: 기존 폴더 건너뜀
            if dest_dir.exists():
                print(f"  [{idx}] 이미 존재 — 건너뜀: {folder_name}")
                self._append_log(idx, reg_no, title_raw, "건너뜀(resume)", 0, "폴더 이미 존재")
                continue

            time.sleep(self.args.delay)

            # 상세 조회
            try:
                result = self.fetch_detail(item)
            except Exception as e:
                print(f"  [{idx}] 상세 조회 실패: {e}")
                self._append_log(idx, reg_no, title_raw, "상세조회실패", 0, str(e))
                continue

            if result is None:
                self._append_log(idx, reg_no, title_raw, "파싱실패", 0, "result 추출 불가")
                continue

            detail_vo = result.get("openCateSearchVO", {})
            if not detail_vo:
                detail_vo = result
            file_list = result.get("fileList", [])

            # 공개 여부 확인
            opp_se_cd = detail_vo.get("oppSeCd", "")
            urtxt_yn = detail_vo.get("urtxtYn", "Y")
            dta_redg = detail_vo.get("dtaRedgLmttEndYmd", "")

            dest_dir.mkdir(parents=True, exist_ok=True)

            # metadata.md 작성
            self.write_metadata(dest_dir, detail_vo, file_list, reg_no)

            doc_record = self._build_doc_record(idx, item, detail_vo, file_list, [])

            if self.args.skip_files:
                self._append_log(idx, reg_no, title_raw, "메타만저장", 0, "--skip-files")
                self._sync_to_supabase(doc_record, file_list, set(), {}, keyword, "ok")
                collected_count += 1
                continue

            # 파일 다운로드
            downloaded = []
            downloaded_ids = set()
            storage_paths = {}
            for fi in file_list:
                file_opp_yn = fi.get("fileOppYn", "N")
                ok, reason = can_download(opp_se_cd, file_opp_yn, urtxt_yn, dta_redg, self.today)
                if not ok:
                    print(f"    파일 건너뜀 ({reason}): {fi.get('fileNm', '')}")
                    continue

                time.sleep(self.args.delay)
                try:
                    path = self.download_file(fi, detail_vo, dest_dir)
                    if path:
                        downloaded.append(path)
                        fid = fi.get("fileId", "")
                        downloaded_ids.add(fid)
                        storage_paths[fid] = str(path)
                        print(f"    저장: {path.name}")
                except Exception as e:
                    print(f"    다운로드 실패: {fi.get('fileNm', '')} — {e}")

            status = "완료" if downloaded else ("메타만저장" if file_list else "파일없음")
            note = f"{len(downloaded)}/{len(file_list)} 파일"
            self._append_log(idx, reg_no, title_raw, status, len(downloaded), note)

            doc_record["downloaded_count"] = len(downloaded)
            doc_record["downloaded_files"] = [str(p) for p in downloaded]

            # Supabase 동기화: documents + files
            self._sync_to_supabase(doc_record, file_list, downloaded_ids, storage_paths, keyword, "ok")
            collected_count += 1

        # Supabase: 수집 실행 완료 기록
        if self.supabase and run_id:
            try:
                self.supabase.finish_run(run_id, collected_count, "done")
            except Exception as e:
                print(f"[Supabase] finish_run 실패: {e}")

        # ZIP 생성
        if self.args.zip:
            self._create_zip()

        print(f"\n[수집 완료] {collected_count}건 처리, 로그: {self.output_dir / 'collection_log.csv'}")

    # -- Supabase sync helper ----------------------------------------------

    def _sync_to_supabase(self, doc_record: dict, file_list: list,
                          downloaded_ids: set, storage_paths: dict,
                          keyword: str, status: str):
        if not self.supabase:
            return
        try:
            doc_id = self.supabase.upsert_document(doc_record, keyword=keyword, status=status)
            if doc_id and file_list:
                self.supabase.upsert_files(doc_id, file_list, downloaded_ids, storage_paths)
        except Exception as e:
            print(f"  [Supabase] 동기화 실패 (로컬 계속): {e}")

    # -- record builder ----------------------------------------------------

    def _build_doc_record(self, idx: int, item: dict, detail_vo: dict,
                          file_list: list, downloaded: list) -> dict:
        return {
            "index": idx,
            "prdctn_instt_regist_no": item.get("PRDCTN_INSTT_REGIST_NO", ""),
            "info_sj": html.unescape(detail_vo.get("infoSj", "") or item.get("INFO_SJ", "")),
            "doc_no": detail_vo.get("docNo", "") or item.get("DOC_NO", ""),
            "proc_instt_nm": detail_vo.get("prcsNstNm", "") or item.get("PROC_INSTT_NM", ""),
            "chrg_dept_nm": detail_vo.get("chrgDeptNm", "") or item.get("CHRG_DEPT_NM", ""),
            "charger_nm": detail_vo.get("chgrNmpn", "") or item.get("CHARGER_NM", ""),
            "prdctn_dt": detail_vo.get("prdnDt", "") or item.get("PRDCTN_DT", ""),
            "prsrv_pd_cd": detail_vo.get("prsrvPdCd", ""),
            "unit_job_nm": detail_vo.get("unitJobNm", "") or item.get("UNIT_JOB_NM", ""),
            "opp_se_cd": detail_vo.get("oppSeCd", "") or item.get("OTHBC_SE_CD", ""),
            "instt_cd": detail_vo.get("nstCd", "") or item.get("INSTT_CD", ""),
            "instt_se_cd": detail_vo.get("nstSeCd", "") or item.get("INSTT_SE_CD", ""),
            "nst_cl_nm": detail_vo.get("nstClNm", ""),
            "dta_redg_lmtt_end_ymd": detail_vo.get("dtaRedgLmttEndYmd", ""),
            "file_count": len(file_list),
            "downloaded_count": len(downloaded),
            "downloaded_files": [str(p) for p in downloaded],
            "collected_at": datetime.now().isoformat(),
        }

    # -- ZIP ---------------------------------------------------------------

    def _create_zip(self):
        zip_path = self.output_dir.with_suffix(".zip")
        print(f"[ZIP] {zip_path} 생성 중...")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(self.output_dir):
                for file in files:
                    full = Path(root) / file
                    arcname = full.relative_to(self.output_dir)
                    zf.write(full, arcname)
        print(f"[ZIP] 완료: {zip_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    today = datetime.now()
    default_start = (today - timedelta(days=30)).strftime("%Y%m%d")
    default_end = today.strftime("%Y%m%d")

    p = argparse.ArgumentParser(
        description="open.go.kr 원문정보 자동 수집기",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
사용 예시:
  python open_go_kr_collector.py -k "예산" -n 20
  python open_go_kr_collector.py -k "환경부" -s 20240101 -e 20240131 -o ./env_docs
  python open_go_kr_collector.py -k "교육" --skip-files
""",
    )
    p.add_argument("-k", "--keyword", default="", help="검색 키워드")
    p.add_argument("-s", "--start-date", default=default_start, help="시작일(YYYYMMDD, 기본 30일 전)")
    p.add_argument("-e", "--end-date", default=default_end, help="종료일(YYYYMMDD, 기본 오늘)")
    p.add_argument("--instt-cd", default="", help="기관코드")
    p.add_argument("--instt-se-cd", default="", help="기관구분코드")
    p.add_argument("--othbc-se-cd", default="", help="공개구분코드")
    p.add_argument("-n", "--max-count", type=int, default=10, help="최대 수집 건수 (기본 10)")
    p.add_argument("-o", "--output-dir", default="./open_go_kr_docs", help="출력 디렉토리")
    p.add_argument("-d", "--delay", type=float, default=1.0, help="요청 간 딜레이(초, 기본 1.0)")
    p.add_argument("--skip-files", action="store_true", help="파일 다운로드 건너뛰기 (메타만 수집)")
    p.add_argument("--zip", action="store_true", help="수집 완료 후 ZIP 생성")
    p.add_argument("--supabase-url", default="", help="Supabase URL (또는 SUPABASE_URL 환경변수)")
    p.add_argument("--supabase-key", default="", help="Supabase Service Key (또는 SUPABASE_SERVICE_KEY 환경변수)")
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    collector = OpenGoKrCollector(args)
    collector.run()


if __name__ == "__main__":
    main()
