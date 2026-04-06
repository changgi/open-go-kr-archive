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
    return NextResponse.json({ error: "File data not available" }, { status: 404 });
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
