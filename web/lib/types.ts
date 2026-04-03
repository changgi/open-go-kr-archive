export interface Document {
  id: string;
  prdctn_instt_regist_no: string;
  info_sj: string | null;
  doc_no: string | null;
  proc_instt_nm: string | null;
  chrg_dept_nm: string | null;
  charger_nm: string | null;
  prdctn_dt: string | null;
  prsrv_pd_cd: string | null;
  unit_job_nm: string | null;
  opp_se_cd: string | null;
  opp_se_nm: string | null;
  nst_cl_nm: string | null;
  dta_redg_lmtt_end_ymd: string | null;
  instt_cd: string | null;
  instt_se_cd: string | null;
  keyword: string | null;
  collected_at: string;
  status: string;
  note: string | null;
}

export interface FileRecord {
  id: string;
  document_id: string;
  file_id: string | null;
  file_nm: string | null;
  file_se_dc: string | null;
  file_byte_num: number | null;
  file_opp_yn: string | null;
  downloaded: boolean;
  storage_path: string | null;
}

export interface CollectionRun {
  id: string;
  keyword: string | null;
  start_date: string | null;
  end_date: string | null;
  total_found: number;
  total_collected: number;
  started_at: string;
  finished_at: string | null;
  status: string;
}

export interface DocumentWithFiles extends Document {
  files: FileRecord[];
}

export interface StatsData {
  totalDocuments: number;
  todayCount: number;
  topInstitutions: { name: string; count: number }[];
  lastCollectedAt: string | null;
}

export const OPP_SE_LABELS: Record<string, string> = {
  "1": "공개",
  "2": "부분공개",
  "3": "비공개",
  "5": "열람제한",
};

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  if (dateStr.length === 8) {
    return `${dateStr.slice(0, 4)}.${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}`;
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("ko-KR");
}
