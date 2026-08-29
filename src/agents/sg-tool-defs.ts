import { z } from "zod";
import {
  getPolicy,
  getPolicySource,
  getProvider,
  searchPolicies,
  searchProviders,
} from "../knowledge/index.js";

/**
 * Runtime-independent definitions of the Sovereignty Graph knowledge tools
 * (sg_search_providers, sg_get_provider, sg_search_policies, sg_get_policy,
 * sg_get_policy_source). Every adapter that exposes SG knowledge through an
 * MCP-shaped tool-calling mechanism builds its server from this same list,
 * so the tool names, descriptions, input schemas, and behavior can't drift
 * between adapters: src/agents/sg-tools.ts wraps these for the Claude Agent
 * SDK's in-process MCP server, src/agents/sg-mcp-server.ts wraps them for an
 * external stdio MCP server (used by SwivalAgent today; a future
 * Codex/Copilot adapter can spawn the same server).
 */

export interface SgToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * `handler` takes `any` rather than a type derived from `inputSchema`
 * because these defs are stored in one heterogeneous array
 * (`sgToolDefs`) — each entry's handler is still authored right next to
 * its own concrete `inputSchema` below, so the pairing is correct in
 * practice, but TypeScript can't express "this handler's argument type
 * matches this specific schema" across a mixed-shape array element type
 * without existential types. The MCP/Claude SDK `tool()` registration
 * call sites re-validate args against `inputSchema` at runtime regardless.
 */
export interface SgToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<SgToolResult>;
}

function jsonResult(value: unknown): SgToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function notFoundResult(kind: string, id: string): SgToolResult {
  return {
    content: [{ type: "text", text: `No ${kind} record found for id "${id}".` }],
    isError: true,
  };
}

export const sgToolDefs: SgToolDef[] = [
  {
    name: "sg_search_providers",
    description:
      "Search Sovereignty Graph's provider knowledge (cloud/AI vendor data-residency reference material) by keyword. Call this once you've identified a specific third-party integration in the repository — do not assume a provider's jurisdiction from memory.",
    inputSchema: {
      query: z
        .string()
        .describe('Keyword(s) to search for, e.g. a vendor or SDK name like "twilio" or "bedrock".'),
    },
    handler: async ({ query }) => jsonResult(await searchProviders(query)),
  },

  {
    name: "sg_get_provider",
    description:
      "Fetch the full Sovereignty Graph provider record by id, as returned by sg_search_providers. If this returns not-found, SG has no reference material for that provider — report that explicitly in your finding instead of guessing its residency.",
    inputSchema: { id: z.string().describe('Provider record id, e.g. "aws".') },
    handler: async ({ id }) => {
      const record = await getProvider(id);
      return record ? jsonResult(record) : notFoundResult("provider", id);
    },
  },

  {
    name: "sg_search_policies",
    description:
      "Search Sovereignty Graph's policy knowledge (BC Government data-residency/privacy policy reference material) by keyword. Call this once repository evidence raises a sovereignty, privacy, or cross-border question.",
    inputSchema: {
      query: z.string().describe('Keyword(s) to search for, e.g. "personal information outside Canada".'),
    },
    handler: async ({ query }) => jsonResult(await searchPolicies(query)),
  },

  {
    name: "sg_get_policy",
    description:
      "Fetch the full Sovereignty Graph policy record by id, as returned by sg_search_policies. Base policyAlignment conclusions only on the content this returns, not on remembered legislation or policy.",
    inputSchema: { id: z.string().describe('Policy record id, e.g. "bc-foippa-overview".') },
    handler: async ({ id }) => {
      const record = await getPolicy(id);
      return record ? jsonResult(record) : notFoundResult("policy", id);
    },
  },

  {
    name: "sg_get_policy_source",
    description:
      "Fetch a policy record's separate underlying source document, when it references one. Returns not-found if this policy has no separate source record — that's expected for most policy records today.",
    inputSchema: { id: z.string().describe("Policy source record id.") },
    handler: async ({ id }) => {
      const record = await getPolicySource(id);
      return record ? jsonResult(record) : notFoundResult("policy source", id);
    },
  },
];
