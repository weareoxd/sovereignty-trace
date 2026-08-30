import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createRepositoryToolDefs, type RepositoryToolContext } from "./sg-repo-tool-defs.js";
import { sgToolDefs } from "./sg-tool-defs.js";

/**
 * Exposes Sovereignty Graph's read-only knowledge to the Claude Code agent as
 * callable tools, via the Claude Agent SDK's in-process MCP server mechanism.
 * This is the Claude-specific half of that integration: the tool definitions
 * themselves live in ./sg-tool-defs.ts and ./sg-repo-tool-defs.ts, which have
 * no idea this adapter exists, so SwivalAgent (./sg-mcp-server.ts) and a
 * future Codex/Copilot adapter can expose the same tools through their own
 * mechanism instead.
 *
 * The provider/policy tools are stateless; the repository evidence tool needs
 * to know which repository is under assessment, so the server is built per
 * session rather than exported as a constant.
 */
export function createSgServer(context: RepositoryToolContext) {
  const defs = [...sgToolDefs, ...createRepositoryToolDefs(context)];
  return createSdkMcpServer({
    name: "sg",
    version: "1.0.0",
    tools: defs.map((def) => tool(def.name, def.description, def.inputSchema, def.handler)),
  });
}
