# Architecture

## Why a coding agent instead of a static-analysis engine

Data-sovereignty assessment requires understanding what a repository does —
its architecture, what data it handles, and where that data is likely to
go — not just matching source code against known sink signatures. Building
and maintaining a bespoke static-analysis engine (parsers per language,
taint tracking, Terraform/CloudFormation parsing, a provider-domain
matching table) is a large, ongoing undertaking that duplicates
capabilities existing coding agents already have: reading and reasoning
about arbitrary codebases, following imports and configuration across
files, and running shell commands to inspect a repository the way an
engineer would.

Sovereignty Graph instead launches and controls an existing coding agent to
do the investigation, and keeps its own responsibility narrow:

1. Control the coding-agent process (start it, feed it instructions, read
   its output, resume or cancel it).
2. Give it a consistent, written assessment methodology
   ([`prompts/methodology.md`](../prompts/methodology.md)) — how to
   investigate, what to look for, how to record evidence, how to represent
   unknowns, and how to structure the final answer. This is the *only*
   content in the session's opening instructions.
3. Expose trusted provider ([`providers/`](../providers/)) and policy
   ([`policies/`](../policies/)) reference material as **on-demand
   knowledge** the agent queries once it has actually identified something
   worth grounding — not as content preloaded into every session.
4. Require its output to conform to a structured, evidence-backed schema
   ([`src/assessment/schema.ts`](../src/assessment/schema.ts)) that
   captures which provider/policy records it used.
5. Validate that output before treating it as a result
   ([`src/assessment/validation.ts`](../src/assessment/validation.ts)),
   including that every cited provider/policy record actually exists.

The agent is responsible for understanding the repository *and* for
discovering which provider/policy knowledge is relevant to it. Sovereignty
Graph is responsible for the fixed methodology, for grounding external
facts through its own trusted knowledge rather than the agent's training
data, and for checking the agent's work.

## Methodology vs. knowledge

These are two different things and the architecture keeps them apart:

- **Methodology** ([`prompts/`](../prompts/)) is instructions — it goes in
  the opening prompt of every session, because every assessment needs it
  regardless of what the repository turns out to contain.
- **Provider and policy knowledge** ([`providers/`](../providers/),
  [`policies/`](../policies/)) is reference data — it is *not* instructions
  and is never dumped into the opening prompt. A given repository might
  touch one provider or a dozen; loading all of them up front would waste
  context on material that's irrelevant to this particular assessment, and
  would not scale as more providers/policies are added. Instead the agent
  discovers what's relevant by investigating the repository, then retrieves
  only those specific records through the SG knowledge interface described
  below.

This split is what lets the same knowledge interface serve any coding-agent
runtime: methodology is just text handed to `startSession`, while knowledge
is exposed through whatever on-demand tool-calling mechanism that runtime
supports (MCP, function calling, or otherwise).

## The SG knowledge interface

[`src/knowledge/`](../src/knowledge/) is a small, runtime-independent,
read-only API over `providers/` and `policies/`:

- `searchProviders(query)` / `getProvider(id)`
- `searchPolicies(query)` / `getPolicy(id)`
- `getPolicySource(id)` — a policy record's separate underlying source
  document, for policy frameworks that reference one (none do yet; this
  degrades to "not found" until a `policy-sources/` directory exists).

It does no reasoning about providers or policy — it only loads and searches
the records already in those directories (structured YAML for providers,
rendered to text; Markdown for policies), the same content that used to be
embedded directly in the instructions. Nothing about it is Claude-specific,
so any future adapter can call these functions directly.

### Claude Code integration

[`src/agents/sg-tools.ts`](../src/agents/sg-tools.ts) is the Claude-specific
half: it wraps the four (five, counting `getPolicySource`) SG knowledge
functions as an in-process MCP server using the Claude Agent SDK's
`createSdkMcpServer` / `tool` helpers, and registers it with the session via
`mcpServers: { sg: sgKnowledgeServer }` in
[`src/agents/claude-code.ts`](../src/agents/claude-code.ts). The agent sees
them as ordinary callable tools: `sg_search_providers`, `sg_get_provider`,
`sg_search_policies`, `sg_get_policy`, `sg_get_policy_source`.

A Codex or Copilot adapter would import the same functions from
`src/knowledge/` and register them through whatever tool/function-calling
mechanism that runtime exposes — the `CodingAgent` core interface doesn't
need to know this integration exists, and `src/knowledge/` doesn't need to
know Claude Code exists.

## Pipeline

```
Sovereignty Graph (CLI / library)
    -> CodingAgent.startSession({ cwd, instructions, outputSchema, ... })
    -> Claude Code SDK (query()), with the SG knowledge MCP server registered
    -> repository investigation (agent reads/greps/runs commands in cwd)
         -> agent identifies an integration
         -> agent calls sg_search_providers / sg_get_provider on demand
         -> agent identifies a sovereignty/privacy question
         -> agent calls sg_search_policies / sg_get_policy on demand
    -> structured sovereignty assessment (agent's final answer, matching outputSchema),
       citing the specific provider/policy record ids it retrieved
    -> validated against the schema + evidence-file-exists check
       + cited provider/policy record ids actually exist
    -> Markdown / JSON report
```

`src/run-assessment.ts` wires this together: it builds instructions from
[`src/assessment/methodology.ts`](../src/assessment/methodology.ts) (which
loads only `prompts/role.md` and `prompts/methodology.md` — no provider or
policy content), starts a session via the `CodingAgent` passed to it (for
Claude Code, this also registers the SG knowledge MCP server), drains its
event stream, and validates the resulting structured output via
[`src/assessment/validation.ts`](../src/assessment/validation.ts).

## The `CodingAgent` interface

[`src/agents/agent.ts`](../src/agents/agent.ts) defines the boundary between
Sovereignty Graph and whatever runtime actually performs the investigation.
It deliberately normalizes only what Sovereignty Graph needs:

- **Starting a session**: `startSession({ cwd, instructions, ... })`.
- **Setting the repository working directory**: `cwd` on session options —
  every runtime under consideration (Claude Code, Codex, Copilot) supports
  scoping a session to a working directory.
- **Supplying instructions**: `instructions`, given as the session's
  opening prompt.
- **Receiving events/results**: `session.events()` yields a normalized
  event union (`text`, `tool_use`, `tool_result`, `error`, `result`,
  `session_started`); `session.result()` resolves once a terminal result is
  reached.
- **Resuming a session**: `resumeSessionId` on session options, using the
  runtime's own session id from a prior `CodingAgentResult`.
- **Cancellation**: `session.cancel()`, backed by `AbortSignal` internally.
- **Structured output**: `outputSchema` (a JSON Schema), surfaced as
  `CodingAgentResult.structuredOutput`.

What it deliberately does **not** normalize: tool names and behavior,
permission models, cost/usage accounting detail, or anything else specific
to one runtime. `CodingAgentEvent`'s `tool_use`/`tool_result` variants carry
runtime-native tool names and payloads as-is rather than mapping them to a
shared vocabulary — Sovereignty Graph only needs to observe and log them,
not act on them.

[`src/agents/claude-code.ts`](../src/agents/claude-code.ts) is the only
implemented adapter, wrapping `@anthropic-ai/claude-agent-sdk`'s `query()`.
[`src/agents/codex.ts`](../src/agents/codex.ts) and
[`src/agents/copilot.ts`](../src/agents/copilot.ts) are placeholders: they
implement `CodingAgent` but throw on `startSession`, which exists to prove
the interface doesn't assume anything Claude Code-specific before those
adapters are actually built.

## The structured assessment schema

[`src/assessment/schema.ts`](../src/assessment/schema.ts) defines
`SovereigntyAssessmentSchema` with Zod, and derives the JSON Schema passed
to the agent from it (`z.toJSONSchema`) so the two never drift apart. Every
data-movement finding requires at least one piece of evidence (a repository
file path, optionally a line range and snippet) — the schema enforces this
structurally rather than relying on the agent to remember to cite sources.

Findings also reference SG knowledge records explicitly, rather than only
naming a vendor or policy in prose:

- `DataMovementFinding.providerReference` — `{ id, available }`, the SG
  provider record id the agent looked up (`sg_get_provider`) and whether
  one was actually found. `available: false` means the agent identified a
  provider but SG has no reference material for it — a fact worth
  surfacing, not a validation failure.
- `PolicyAlignment.policyReference` — `{ id, section?, sourceId? }`, the SG
  policy record id the agent looked up (`sg_get_policy`), an optional
  section/anchor within it, and an optional separate source document id
  (`sg_get_policy_source`).

## Validation

Validation is intentionally basic, matching the "no custom static-analysis
engine" constraint: `validateAssessment` (in
[`src/assessment/validation.ts`](../src/assessment/validation.ts), now
async since it consults `src/knowledge/`) parses the agent's output against
the Zod schema, then checks:

- every evidence `file` path cited actually exists in the repository that
  was assessed (and doesn't resolve outside it);
- every `providerReference.id` exists in SG provider knowledge
  (`getProvider`) — an error if not, since the agent asserted it as a
  lookup it made;
- every `policyReference.id` exists in SG policy knowledge (`getPolicy`) —
  an error if not;
- every `policyReference.sourceId`, when present, exists in SG policy
  source knowledge (`getPolicySource`) — a warning if not, since policy
  source records aren't modeled for every policy today.

This catches the most basic failure modes — an agent citing evidence or a
knowledge record that doesn't exist — without attempting to verify that the
evidence or knowledge actually *supports* the finding, or that the
finding's reasoning is semantically correct, which would require the kind
of bespoke analysis this project deliberately avoids building.

## Adding a new agent runtime

1. Implement `CodingAgent` in `src/agents/<runtime>.ts`, translating the
   runtime's native session/streaming API into `CodingAgentSession` and
   `CodingAgentEvent`.
2. Expose the SG knowledge functions (`src/knowledge/index.ts`) as callable
   tools through whatever mechanism that runtime supports — its own
   function-calling API, an MCP client, or otherwise. Two options already
   exist: `src/agents/sg-tools.ts` wraps them as an in-process MCP server
   for the Claude Agent SDK; `src/agents/sg-mcp-server.ts` wraps the same
   tool definitions (`src/agents/sg-tool-defs.ts`) as an external stdio MCP
   server, for a runtime that only connects to MCP servers as subprocesses
   (used by `SwivalAgent`; likely reusable as-is for Codex/Copilot). Either
   way, this is adapter-specific glue — it should not require changes to
   `src/knowledge/` itself.
3. If the runtime can't natively enforce a JSON Schema on its output, do
   your best effort and leave `structuredOutput` undefined when that fails
   — `runAssessment` already treats a missing `structuredOutput` as a
   failed assessment. Parsing the final chat message as JSON is the
   fallback of last resort, not the primary mechanism: models asked for a
   long structured answer tend to draft it into a file with a write tool
   instead of restating it in chat (see the empirically-confirmed behavior
   below), so if the runtime can grant scoped write access to a directory
   outside the repository being assessed, designate a fixed path there as
   the answer channel and read it back directly. `src/agents/swival.ts`'s
   `buildPromptText` / `resolveFinalAnswer` / `tryParseJson` is a worked
   example of all three layers: output file, then chat-text parse, then one
   corrective nudge.
4. Nothing else in the codebase should need to change — `run-assessment.ts`
   and the CLI depend only on the `CodingAgent` interface.

### Adapter runtime models differ, and that's fine

`ClaudeCodeAgent` calls the Claude Agent SDK in-process (`query()` is a
function call into code already running in this process). `SwivalAgent`
instead spawns swival as a child process and speaks its `--acp` protocol
(newline-delimited JSON-RPC 2.0 on stdio — the [Agent Client
Protocol](https://agentclientprotocol.com), same one Zed uses) over
`stdin`/`stdout`. The `CodingAgent` interface doesn't care which shape a
given runtime is; `CodingAgentSession` just needs to produce the same event
stream either way. A Codex or Copilot adapter may turn out to be an SDK call
like Claude, a spawned CLI process like swival, or something else again.

Three swival-specific behaviors were confirmed empirically (against swival
1.0.41) while building `SwivalAgent`, rather than being documented anywhere:
disagreeing with any of them would silently break the adapter, so a future
maintainer bumping swival versions should re-check them:

- ACP framing is one JSON object per line. It is *not* LSP-style
  `Content-Length`-prefixed framing, despite superficially resembling other
  JSON-RPC-over-stdio protocols that use that framing.
- `session/new`'s `mcpServers` parameter looks like the right place to
  attach `sg-mcp-server.ts`, but swival's ACP server rejects any non-empty
  value there ("ACP-provided MCP servers are not supported by this agent").
  MCP servers have to be declared in a `--mcp-config <file>` JSON file
  passed as a CLI argument when the process is spawned instead; `session/new`
  must still be called with `mcpServers: []`. `SwivalAgent` writes this file
  to a temp directory per session and cleans it up afterward.
- Asked for a long structured final answer, the underlying model tends to
  draft it into a file with a write tool rather than restate it in its final
  chat message — observed twice, against two different repositories, each
  time with a different, unrequested filename, and each time inside the
  repository being assessed (swival's default workspace file access permits
  writes there; there's no read-only mode for the base workspace). The
  session still ends cleanly (`stopReason: "end_turn"`), so nothing signals
  the failure except an empty final answer. `SwivalAgent` works with this
  instead of against it: it grants swival `--add-dir <scratch-dir>` write
  access to a temp directory outside the repository, tells the model that
  path is the only file it may write, and reads that file directly rather
  than relying on the model to repeat the answer in chat.
