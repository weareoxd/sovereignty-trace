import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { sgToolDefs } from "./sg-tool-defs.js";

/**
 * Exposes Sovereignty Graph's read-only provider/policy knowledge
 * (src/knowledge/) to the Claude Code agent as callable tools, via the
 * Claude Agent SDK's in-process MCP server mechanism. This is the
 * Claude-specific half of that integration: the tool definitions themselves
 * live in ./sg-tool-defs.ts, which has no idea this adapter exists, so
 * SwivalAgent (./sg-mcp-server.ts) and a future Codex/Copilot adapter can
 * expose the same tools through their own mechanism instead.
 */
export const sgKnowledgeServer = createSdkMcpServer({
  name: "sg",
  version: "1.0.0",
  tools: sgToolDefs.map((def) => tool(def.name, def.description, def.inputSchema, def.handler)),
});
