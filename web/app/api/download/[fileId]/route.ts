import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  const supabase = createServerSupabase();

  // Use RPC or direct query to get large file_data
  const { data: fileRows, error } = await supabase
    .rpc("get_file_data", { p_file_id: params.fileId })
    .single() as any;

  // Fallback to regular select if RPC not available
  let file = fileRows;
  if (error || !file) {
    const { data: f2, error: e2 } = await supabase
      .from("files")
      .select("file_nm, file_ext, file_data, file_byte_num")
      .eq("file_id", params.fileId)
      .single();
    file = f2;
    if (e2 || !file) {
      return NextResponse.json({ error: "File not found", detail: e2?.message || error?.message }, { status: 404 });
    }
  }

  if (!file.file_data) {
    // DB에 파일 데이터가 없으면 안내
    return NextResponse.json({
      error: "파일 데이터가 DB에 저장되지 않았습니다",
      hint: "수집 시 ENABLE_DB_FILE_DATA=true 또는 ENABLE_STORAGE_UPLOAD=true 설정이 필요합니다",
      fileName: file.file_nm,
    }, { status: 404 });
  }

  const buffer = Buffer.from(file.file_data, "base64");
  const fileName = file.file_nm || "download";

  // MIME type mapping
  const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".hwp": "application/x-hwp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".txt": "text/plain",
  };
  const ext = (file.file_ext || "").toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(buffer.length),
    },
  });
}
