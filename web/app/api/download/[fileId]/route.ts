import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  const supabase = createServerSupabase();

  const { data: file, error } = await supabase
    .from("files")
    .select("file_nm, file_ext, file_data, file_byte_num")
    .eq("file_id", params.fileId)
    .single();

  if (error || !file) {
    return NextResponse.json({ error: "File not found", detail: error?.message, fileId: params.fileId }, { status: 404 });
  }

  if (!file.file_data) {
    return NextResponse.json({ error: "File data not available", fileId: params.fileId, hasFile: !!file, hasData: !!file?.file_data, fileName: file?.file_nm }, { status: 404 });
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
