import { z } from "zod";
import { supabase } from "../lib/supabase.js";

export const getDocumentSchema = z.object({
  registNo: z
    .string()
    .describe("원문등록번호 (prdctn_instt_regist_no)"),
});

export type GetDocumentInput = z.infer<typeof getDocumentSchema>;

export async function getDocument(input: GetDocumentInput) {
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("prdctn_instt_regist_no", input.registNo)
    .single();

  if (docError) throw new Error(`Document not found: ${docError.message}`);

  const { data: files, error: filesError } = await supabase
    .from("files")
    .select("*")
    .eq("document_id", doc.id);

  if (filesError) throw new Error(`Files query failed: ${filesError.message}`);

  return { document: doc, files: files ?? [] };
}
