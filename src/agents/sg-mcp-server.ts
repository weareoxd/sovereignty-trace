#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRepositoryToolDefs } from "./sg-repo-tool-defs.js";
import { sgToolDefs } from "./sg-tool-defs.js";

/**
 * Standalone MCP server exposing Sovereignty Graph's knowledge (../knowledge/)
 * and the repository evidence tool over stdio, for coding-agent runtimes that
 * connect to MCP servers as external subprocesses rather than in-process
 * (SwivalAgent today; Codex/Copilot adapters can spawn this same script
 * once built). Not imported by other modules — run directly, e.g.
 * `node dist/agents/sg-mcp-server.js /path/to/repository`.
 *
 * The repository under assessment is taken from the first argument, falling
 * back to the working directory the server was spawned in.
 */
async function main(): Promise<void> {
  const server = new McpServer({ name: "sg", version: "1.0.0" });
  const repositoryPath = process.argv[2] ?? process.cwd();

  for (const def of [...sgToolDefs, ...createRepositoryToolDefs({ repositoryPath })]) {
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
