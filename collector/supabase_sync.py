"""
Supabase 동기화 모듈
- 테이블: documents, files, collection_runs (001_initial_schema.sql 기준)
- Supabase 실패 시에도 로컬 저장은 계속됩니다.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

try:
    from supabase import create_client, Client
except ImportError:
    create_client = None
    Client = None

OPP_SE_LABELS = {"1": "공개", "2": "부분공개", "3": "비공개", "5": "열람제한"}


def _yyyymmdd_to_date(val: str) -> Optional[str]:
    """YYYYMMDD → YYYY-MM-DD (DATE 컬럼용). 빈 값이면 None."""
    if val and len(val) == 8:
        return f"{val[:4]}-{val[4:6]}-{val[6:]}"
    return None


class SupabaseSync:
    """open.go.kr 수집 데이터를 Supabase에 동기화합니다."""

    TABLE_DOCUMENTS = "documents"
    TABLE_FILES = "files"
    TABLE_RUNS = "collection_runs"

    def __init__(self, url: str, key: str):
        if create_client is None:
            raise ImportError("supabase 패키지가 설치되지 않았습니다: pip install supabase")
        self.client: Client = create_client(url, key)

    # ------------------------------------------------------------------
    # collection_runs
    # ------------------------------------------------------------------

    def start_run(self, keyword: str, start_date: str, end_date: str,
                  total_found: int = 0) -> Optional[str]:
        """수집 실행 시작을 기록하고 run id(UUID)를 반환합니다."""
        row = {
            "keyword": keyword,
            "start_date": _yyyymmdd_to_date(start_date),
            "end_date": _yyyymmdd_to_date(end_date),
            "total_found": total_found,
            "status": "running",
        }
        try:
            result = self.client.table(self.TABLE_RUNS).insert(row).execute()
            if result.data:
                return result.data[0]["id"]
        except Exception as e:
            print(f"[Supabase] start_run 실패: {e}")
        return None

    def finish_run(self, run_id: str, total_collected: int, status: str = "done"):
        """수집 실행 완료를 기록합니다."""
        row = {
            "total_collected": total_collected,
            "finished_at": datetime.utcnow().isoformat(),
            "status": status,
        }
        try:
            self.client.table(self.TABLE_RUNS).update(row).eq("id", run_id).execute()
        except Exception as e:
            print(f"[Supabase] finish_run 실패: {e}")

    # ------------------------------------------------------------------
    # documents
    # ------------------------------------------------------------------

    def upsert_document(self, doc: Dict[str, Any], keyword: str = "",
                        status: str = "ok", note: str = "") -> Optional[str]:
        """문서 메타데이터를 upsert하고 document UUID를 반환합니다."""
        opp_se_cd = doc.get("opp_se_cd", "")
        row = {
            "prdctn_instt_regist_no": doc["prdctn_instt_regist_no"],
            "info_sj": doc.get("info_sj", ""),
            "doc_no": doc.get("doc_no", ""),
            "proc_instt_nm": doc.get("proc_instt_nm", ""),
            "chrg_dept_nm": doc.get("chrg_dept_nm", ""),
            "charger_nm": doc.get("charger_nm", ""),
            "prdctn_dt": _yyyymmdd_to_date(doc.get("prdctn_dt", "")),
            "prsrv_pd_cd": doc.get("prsrv_pd_cd", ""),
            "unit_job_nm": doc.get("unit_job_nm", ""),
            "opp_se_cd": opp_se_cd,
            "opp_se_nm": OPP_SE_LABELS.get(opp_se_cd, opp_se_cd),
            "nst_cl_nm": doc.get("nst_cl_nm", ""),
            "dta_redg_lmtt_end_ymd": doc.get("dta_redg_lmtt_end_ymd", "") or None,
            "instt_cd": doc.get("instt_cd", ""),
            "instt_se_cd": doc.get("instt_se_cd", ""),
            "keyword": keyword,
            "status": status,
            "note": note,
        }
        try:
            result = (
                self.client.table(self.TABLE_DOCUMENTS)
                .upsert(row, on_conflict="prdctn_instt_regist_no")
                .execute()
            )
            if result.data:
                return result.data[0]["id"]
        except Exception as e:
            print(f"[Supabase] upsert_document 실패: {e}")
        return None

    # ------------------------------------------------------------------
    # files (FK: document_id UUID)
    # ------------------------------------------------------------------

    def upsert_files(self, document_id: str, file_list: List[Dict[str, Any]],
                     downloaded_ids: Optional[set] = None,
                     storage_paths: Optional[Dict[str, str]] = None):
        """파일 목록을 files 테이블에 삽입합니다."""
        if not document_id or not file_list:
            return
        downloaded_ids = downloaded_ids or set()
        storage_paths = storage_paths or {}

        rows = []
        for fi in file_list:
            fid = fi.get("fileId", "")
            rows.append({
                "document_id": document_id,
                "file_id": fid,
                "file_nm": fi.get("fileNm", ""),
                "file_se_dc": fi.get("fileSeDc", ""),
                "file_byte_num": int(fi.get("fileByteNum", 0) or 0),
                "file_opp_yn": fi.get("fileOppYn", ""),
                "downloaded": fid in downloaded_ids,
                "storage_path": storage_paths.get(fid, ""),
            })

        try:
            self.client.table(self.TABLE_FILES).insert(rows).execute()
        except Exception as e:
            print(f"[Supabase] upsert_files 실패: {e}")

    # ------------------------------------------------------------------
    # 조회 헬퍼
    # ------------------------------------------------------------------

    def get_collected_ids(self) -> set:
        """이미 수집된 문서 등록번호 목록을 반환합니다."""
        try:
            result = (
                self.client.table(self.TABLE_DOCUMENTS)
                .select("prdctn_instt_regist_no")
                .execute()
            )
            return {r["prdctn_instt_regist_no"] for r in (result.data or [])}
        except Exception:
            return set()

    def get_document_id(self, reg_no: str) -> Optional[str]:
        """등록번호로 document UUID를 조회합니다."""
        try:
            result = (
                self.client.table(self.TABLE_DOCUMENTS)
                .select("id")
                .eq("prdctn_instt_regist_no", reg_no)
                .limit(1)
                .execute()
            )
            if result.data:
                return result.data[0]["id"]
        except Exception:
            pass
        return None
