#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sgToolDefs } from "./sg-tool-defs.js";

/**
 * Standalone MCP server exposing Sovereignty Graph's provider/policy
 * knowledge (../knowledge/) over stdio, for coding-agent runtimes that
 * connect to MCP servers as external subprocesses rather than in-process
 * (SwivalAgent today; Codex/Copilot adapters can spawn this same script
 * once built). Not imported by other modules — run directly, e.g.
 * `node dist/agents/sg-mcp-server.js`.
 */
async function main(): Promise<void> {
  const server = new McpServer({ name: "sg", version: "1.0.0" });

  for (const def of sgToolDefs) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      def.handler,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
