import { z } from "zod";
import { supabase } from "../lib/supabase.js";

export const searchDocumentsSchema = z.object({
  keyword: z.string().optional().describe("검색 키워드 (제목, 기관명 등)"),
  startDate: z.string().optional().describe("시작일 (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("종료일 (YYYY-MM-DD)"),
  insttNm: z.string().optional().describe("처리기관명"),
  oppSeCd: z.string().optional().describe("공개구분코드"),
  limit: z.number().default(20).describe("결과 수 (기본 20)"),
  offset: z.number().default(0).describe("오프셋 (기본 0)"),
});

export type SearchDocumentsInput = z.infer<typeof searchDocumentsSchema>;

export async function searchDocuments(input: SearchDocumentsInput) {
  let query = supabase
    .from("documents")
    .select("*", { count: "exact" })
    .order("prdctn_dt", { ascending: false });

  if (input.keyword) {
    query = query.or(
      `info_sj.ilike.%${input.keyword}%,proc_instt_nm.ilike.%${input.keyword}%,unit_job_nm.ilike.%${input.keyword}%`
    );
  }
  if (input.startDate) {
    query = query.gte("prdctn_dt", input.startDate);
  }
  if (input.endDate) {
    query = query.lte("prdctn_dt", input.endDate);
  }
  if (input.insttNm) {
    query = query.ilike("proc_instt_nm", `%${input.insttNm}%`);
  }
  if (input.oppSeCd) {
    query = query.eq("opp_se_cd", input.oppSeCd);
  }

  query = query.range(input.offset, input.offset + input.limit - 1);

  const { data, error, count } = await query;

  if (error) throw new Error(`Search failed: ${error.message}`);

  return {
    total: count ?? 0,
    offset: input.offset,
    limit: input.limit,
    documents: data ?? [],
  };
}
