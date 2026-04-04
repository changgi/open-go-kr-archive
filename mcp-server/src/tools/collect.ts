import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

export const collectDocumentsSchema = z.object({
  keyword: z.string().optional().describe("검색 키워드"),
  maxCount: z.number().default(50).describe("최대 수집 건수 (기본 50)"),
  startDate: z.string().optional().describe("시작일 (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("종료일 (YYYY-MM-DD)"),
});

export type CollectDocumentsInput = z.infer<typeof collectDocumentsSchema>;

export async function collectDocuments(input: CollectDocumentsInput) {
  const browserCollector = path.resolve(__dirname, "../../../collector/browser_collect.mjs");
  const pythonCollector = path.resolve(__dirname, "../../../collector/open_go_kr_collector.py");

  const args: string[] = [];
  if (input.keyword) args.push(`-k "${input.keyword}"`);
  args.push(`-n ${input.maxCount}`);
  if (input.startDate) args.push(`-s ${input.startDate}`);
  if (input.endDate) args.push(`-e ${input.endDate}`);

  const useBrowser = fs.existsSync(browserCollector);
  const command = useBrowser
    ? `node "${browserCollector}" ${args.join(" ")}`
    : `python "${pythonCollector}" ${args.join(" ")}`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 300000,
      env: { ...process.env },
    });

    return {
      success: true,
      message: "수집이 완료되었습니다.",
      stdout: stdout.slice(-2000),
      stderr: stderr ? stderr.slice(-1000) : undefined,
    };
  } catch (error: any) {
    return {
      success: false,
      message: `수집 실패: ${error.message}`,
      stderr: error.stderr?.slice(-1000),
    };
  }
}
