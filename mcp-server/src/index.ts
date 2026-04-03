import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { searchDocuments, searchDocumentsSchema } from "./tools/search.js";
import { getDocument, getDocumentSchema } from "./tools/detail.js";
import { collectDocuments, collectDocumentsSchema } from "./tools/collect.js";
import { getCollectionStats } from "./tools/stats.js";
import { getRecentDocuments } from "./resources/recent.js";
import { getStatsResource } from "./resources/stats.js";

const server = new McpServer({
  name: "open-go-kr",
  version: "1.0.0",
});

// Tools
server.tool(
  "search_documents",
  "정보공개포털 문서를 검색합니다. 키워드, 날짜, 기관명, 공개구분으로 필터링 가능합니다.",
  searchDocumentsSchema.shape,
  async (params) => {
    const result = await searchDocuments(searchDocumentsSchema.parse(params));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_document",
  "원문등록번호로 특정 문서의 상세 정보와 첨부파일 목록을 조회합니다.",
  getDocumentSchema.shape,
  async (params) => {
    const result = await getDocument(getDocumentSchema.parse(params));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "collect_documents",
  "정보공개포털에서 문서를 수집합니다. Python 수집기를 실행하여 Supabase에 저장합니다.",
  collectDocumentsSchema.shape,
  async (params) => {
    const result = await collectDocuments(collectDocumentsSchema.parse(params));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_collection_stats",
  "수집 통계를 조회합니다. 총 문서 수, 기관별 top 10, 최근 수집 이력을 반환합니다.",
  {},
  async () => {
    const result = await getCollectionStats();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Resources
server.resource(
  "recent-documents",
  "documents://recent",
  { description: "최근 수집된 문서 50건", mimeType: "application/json" },
  async () => {
    const data = await getRecentDocuments();
    return { contents: [{ uri: "documents://recent", text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "collection-stats",
  "documents://stats",
  { description: "수집 통계 요약", mimeType: "application/json" },
  async () => {
    const data = await getStatsResource();
    return { contents: [{ uri: "documents://stats", text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("open-go-kr MCP server running on stdio");
}

main().catch(console.error);
