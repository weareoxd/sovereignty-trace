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
   unknowns — along with the policy text and the provider index it will need.
3. Take its answer as **observations only**, and compute everything derived
   from them in code: the quoted evidence, the destination jurisdictions, the
   risk levels, the coverage.

## What the agent decides, and what code decides

This is the load-bearing split, and it was not the original design. When the
agent filled in every field of the assessment itself — including the risk
scores, the jurisdictions, and the snippets it quoted — five runs against the
same commit produced 0, 4, 1, 5 and 4 high-risk findings, and four of the five
failed validation.

The agent now makes six judgments per finding, and writes the prose:

1. That something is a finding at all.
2. Which provider record applies, chosen from a list it is shown.
3. How the data is classified (`personal_information`, `protected_b`,
   `protected_c`, `credentials_or_secrets`, `operational`, `none_identified`,
   `unclassified`).
4. Whether the code path is the active one or an alternate.
5. Which region the repository pins, for a provider that has one.
6. Which component category the finding is filed under, and which others it
   is also relevant to.

Code does the rest, in [`src/assessment/`](../src/assessment/):

- `hydrate-evidence.ts` reads the cited line ranges out of the repository. The
  agent reports a path and a range; it never writes the quoted text, so a
  fabricated quote is not expressible. A citation that doesn't resolve is
  dropped, and a finding whose citations were all dropped goes with it.
- `residency.ts` reads `storage_regions` and `processing_regions` off the
  provider record the agent named. A record without them — every
  customer-configurable cloud, where there is no fixed list to publish — falls
  back to the region the agent read out of the repository, matched against
  that record's own `canadian_regions`. The agent reports a region string it
  saw; code decides what it means.
- `risk.ts` is the scoring rule, as a pure function of classification,
  residency, and active-vs-alternate. It used to be prose in the methodology
  prompt, applied by feel.
- `assemble.ts` enumerates all ten component categories and all six policy
  points, so a category the agent skipped reports as unreported rather than
  vanishing. It also files each finding under its category and cross-references
  it into the others it named.
- `validation.ts` is what's left to check: does the draft parse, and was the
  ground covered.

## Two schemas

[`src/assessment/schema.ts`](../src/assessment/schema.ts) defines both shapes
with Zod and derives the agent's JSON Schema from the first (`z.toJSONSchema`)
so the two never drift apart.

- `AssessmentDraftSchema` is what the agent returns. Evidence entries carry a
  file, a line range, and a note — no snippet. There is no `riskLevel`, no
  `overallRisk`, no `crossesBorder`, no `destinationJurisdiction`.
- `SovereigntyAssessmentSchema` is the finished document, built from the draft.

`providerId` and `ruleId` are enums built at runtime from the record filenames
in `providers/` and the `citable_sections` in `policies/`. That matters: asked
for the id as free text, with no list in front of it, an assessment invented
`ches` for a record named `bcgov-ches`, and the exact-match lookup missed.

## Methodology and knowledge

- **Methodology** ([`prompts/`](../prompts/)) is instructions.
- **Policy text** ([`policies/`](../policies/)) is pasted into every session in
  full — 13.7 KB. It used to be fetched through tools on demand, and the result
  was that runs answered 2, then 4, then 3, then 5, then 4 of the same six
  policy points. Judging alignment means reading the text, so the text is there.
- **Provider records** ([`providers/`](../providers/)) reach the agent only as
  an identification index: id, name, description, and the access-path
  signatures (domains, package names). Under 10 KB. Residency is deliberately
  withheld — that is what code reads off the record afterwards, and showing it
  would invite the agent to restate it from memory.

## The SG knowledge interface

[`src/knowledge/`](../src/knowledge/) is a small, runtime-independent,
read-only API over `providers/` and `policies/`. It does no reasoning; it
loads, validates, and renders the records in those directories.

The store keeps each record in both forms: the rendered prose a person reads,
and the validated entry code reads. `getProvider(id)` returns the prose;
`getProviderEntry(id)` returns the entry the risk score is computed from.

For the assessment pipeline the relevant functions are `buildProviderIndex()`,
`buildPolicyBrief()`, `listProviderIds()`, `listPolicyRules()`, and
`getProviderEntry(id)`.

### No MCP server

There was one, exposing `sg_search_providers`, `sg_get_provider`,
`sg_search_policies`, `sg_get_policy`, `sg_get_policy_source` and
`sg_cite_evidence` — in-process for Claude Code, as a spawned stdio subprocess
for swival. It is gone. Policy text is inlined, provider knowledge is split
into an index for the agent and entries for code, and citations are resolved
against the repository rather than minted through a tool. Both adapters keep
their own file tools, so neither is blinded.

## Pipeline

```
Sovereignty Graph (CLI / library)
 0. gather repo facts (languages, file count, ignore patterns)          [code]
 1. build the brief: role + methodology + provider index + policy text  [code]
 2. investigate; return a draft of observations                        [agent]
 3. read the cited line ranges out of the repository                    [code]
 4. read residency off the named provider records                       [code]
 5. score each finding, roll up the overall risk                        [code]
 6. assemble; check the draft parsed and the ground was covered         [code]
 7. render Markdown / JSON / HTML                                       [code]
```

`src/run-assessment.ts` wires this together. The retry loop fires only when
step 2 returns something that doesn't parse; a dropped citation is handled in
step 3 without another round trip, because sending the whole document back for
a re-print re-rolled every other field along with it.

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

## The scoring rule

The model supplies the classification and the active/alternate flag; code
supplies the residency. [`risk.ts`](../src/assessment/risk.ts) holds the table,
and [`risk.test.ts`](../src/assessment/risk.test.ts) has a case per row.

| Classification | Residency | Active | Alternate |
|---|---|---|---|
| `protected_c` | anything but Canada | high | high |
| `personal_information`, `protected_b`, `protected_c` | outside Canada | high | medium |
| `personal_information`, `protected_b`, `protected_c` | unknown, or no record | high | medium |
| `personal_information`, `protected_b`, `protected_c` | Canada | low | low |
| `credentials_or_secrets` | not Canada | medium | low |
| `operational` | outside Canada | medium | low |
| `operational` | Canada or unknown | low | low |
| `none_identified` | any | low | low |
| `unclassified` | any | unknown | unknown |
| anything | self-hosted | low | low |

Two rows are worth explaining.

**Unknown residency scores the same as leaving Canada.** 16 of 21 provider
records state no storage residency and all 30 are marked `UNVERIFIED`, so the
common case is "record found, residency still unknown". The prose rubric this
replaced had no tier for it — its High tier only covered a *missing* record —
so the agent picked one by feel, and that is most of where the run-to-run
spread came from. Treating unknown as milder would score most of the registry
as safe by default.

**One finding per thing, so one score per thing.** Findings used to be nested
inside the component categories, which meant a resource belonging to two
categories had to be reported once under each. The two copies then drifted: a
BC Parks run described the same OpenSearch cluster as `personal_information`
under "database" and `operational` under "infrastructure", scoring it High and
Low in one document. Findings are a flat list now. Each names one primary
`category` and lists any others in `alsoRelevantTo`, and `assemble.ts`
cross-references it into those rather than copying it, so the score is
computed once no matter how many lenses the finding appears under.

**Self-hosted is low.** A cache or database inside the deployment's own
infrastructure has not moved data across a border. Where the deployment itself
runs is one finding under `infrastructure`, with its own provider record,
rather than a border question restated against every component inside it.

There is no per-finding override. A score that reads wrong means the rule is
wrong and the rule gets changed.

## Validation

What is left to check once the agent stops writing derived fields:

- Does the draft parse against the schema, including the `providerId` and
  `ruleId` enums.
- Were all ten component categories reported on.
- Were all six policy points answered.
- Which citations were dropped, and which findings went with them.

What used to be here and is not any more: evidence-file existence, snippet
matching, and checking that a provider record the agent marked "found" had
actually been found. All three checked things the agent typed from memory, and
it no longer types any of them.

None of this verifies that evidence actually *supports* a finding, or that the
reasoning is sound. That would require the bespoke analysis this project
deliberately avoids building.

## Adding a new agent runtime

1. Implement `CodingAgent` in `src/agents/<runtime>.ts`, translating the
   runtime's native session/streaming API into `CodingAgentSession` and
   `CodingAgentEvent`.
2. Nothing to do for knowledge. Provider and policy material reaches the agent
   through the opening instructions, which `run-assessment.ts` builds the same
   way for every runtime. An adapter only has to deliver `instructions` and a
   working directory, and give the agent some way to read files.
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
- swival's ACP server rejects any non-empty `mcpServers` value on
  `session/new` ("ACP-provided MCP servers are not supported by this agent");
  MCP servers have to be declared in a `--mcp-config <file>` JSON file passed
  at spawn time instead, and `session/new` must still be called with
  `mcpServers: []`. This adapter serves no MCP tools any more, but the
  constraint is recorded here because anything added later runs into it.
- swival accepts `--temperature`, `--seed` and `--top-p`; `SwivalAgent` pins
  the first two. The Claude Agent SDK exposes no equivalent, so
  `ClaudeCodeAgent` runs at the provider default and the two runtimes are not
  comparable on run-to-run variance.
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
