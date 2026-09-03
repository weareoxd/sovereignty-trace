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

Sovereignty Trace instead launches and controls an existing coding agent to
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
- `evidence-handle.ts` clamps a cited range to the file, caps it at 40 lines,
  and mints an `evidenceId` from the path, the range, and the text at it. The
  same lines cited twice produce the same id, and any edit to those lines
  produces a different one, which is what tells you whether a report still
  matches the revision it was written against.
- `nearest-path.ts` names the repository file a dropped citation most likely
  meant. It goes in the warning next to the drop, not back to the agent.
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

`buildNarrowedDraftSchema()` is where those enums get spliced in, and it is used
twice: `assessmentDraftJsonSchema()` converts it to JSON Schema for runtimes
that enforce output natively, and `review.ts` keeps it as Zod for runtimes that
don't (see [In-loop review](#in-loop-review)). One definition, two consumers.

## Methodology and knowledge

- **Methodology** ([`prompts/`](../prompts/)) is instructions.
- **Policy text** ([`policies/`](../policies/)) is pasted into every session in
  full — 12.3 KB. It used to be fetched through tools on demand, and the result
  was that runs answered 2, then 4, then 3, then 5, then 4 of the same six
  policy points. Judging alignment means reading the text, so the text is there.
- **Provider records** ([`providers/`](../providers/)) reach the agent only as
  an identification index: id, name, description, and the access-path
  signatures (domains, package names). 13.9 KB across 31 records. Residency is
  deliberately withheld — that is what code reads off the record afterwards,
  and showing it would invite the agent to restate it from memory.

Section order in the assembled prompt is load-bearing, not cosmetic. Reference
material the agent reads while investigating goes first; the lists it has to
pick values *from* (the policy ids, the categories, the provider index) go
last, next to the schema asking for them. With the provider index sitting 30 KB
from the end, a run on a small local model answered `no_matching_record` nine
times, including for CHES and for S3-compatible storage, both of which have
records it had matched correctly in an earlier run.

## The ST knowledge interface

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

There was one, exposing `st_search_providers`, `st_get_provider`,
`st_search_policies`, `st_get_policy`, `st_get_policy_source` and
`st_cite_evidence` — in-process for Claude Code, as a spawned stdio subprocess
for swival. It is gone. Policy text is inlined, provider knowledge is split
into an index for the agent and entries for code, and citations are resolved
against the repository rather than minted through a tool. Both adapters keep
their own file tools, so neither is blinded.

## Pipeline

```
Sovereignty Trace (CLI / library)
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

Repository name, commit, timing, runtime and model are computed here too rather
than asked of the agent, so they read the same whichever runtime ran the
session. So is the tool-call cap: `maxToolCalls` is counted off the normalized
`tool_use` events and enforced by cancelling the session, which means it
behaves identically for every runtime. It is a valve for a session stuck
re-exploring rather than a default, and a repair round gets its own budget.

Step 2 is also where an adapter may hold the answer to the schema before the
session ends. See [In-loop review](#in-loop-review).

## The `CodingAgent` interface

[`src/agents/agent.ts`](../src/agents/agent.ts) defines the boundary between
Sovereignty Trace and whatever runtime actually performs the investigation.
It deliberately normalizes only what Sovereignty Trace needs:

- **Starting a session**: `startSession({ cwd, instructions, ... })`.
- **Setting the repository working directory**: `cwd` on session options —
  every runtime under consideration (Claude Code, Codex, Copilot) supports
  scoping a session to a working directory.
- **Supplying instructions**: `instructions`, given as the session's
  opening prompt.
- **Receiving events/results**: `session.events()` yields a normalized
  event union (`session_started`, `text`, `notice`, `tool_use`,
  `tool_result`, `error`, `result`); `session.result()` resolves once a
  terminal result is reached. `notice` is the adapter's own progress, kept
  separate from `text` because `text` accumulates into the final answer and
  an adapter's "sending this back for correction" must not.
- **Resuming a session**: `resumeSessionId` on session options, using the
  runtime's own session id from a prior `CodingAgentResult`.
- **Cancellation**: `session.cancel()`, backed by `AbortSignal` internally.
- **Structured output**: `outputSchema` (a JSON Schema), surfaced as
  `CodingAgentResult.structuredOutput`.

What it deliberately does **not** normalize: tool names and behavior,
permission models, cost/usage accounting detail, or anything else specific
to one runtime. `CodingAgentEvent`'s `tool_use`/`tool_result` variants carry
runtime-native tool names and payloads as-is rather than mapping them to a
shared vocabulary — Sovereignty Trace only needs to observe and log them,
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

**Unknown residency scores the same as leaving Canada.** 25 of 31 provider
records state no storage residency and all 31 are marked `UNVERIFIED`, so the
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

The `Canada` and `outside Canada` rows can be reached two ways: off a record's
published `storage_regions`/`processing_regions`, or, for a record that
publishes none, off the region the agent read out of the repository matched
against that record's `canadian_regions`. 16 records declare the configured
region derivable from a repository; 3 (`aws`, `microsoft-azure`,
`google-cloud`) have their Canadian region identifiers filled in so far. A
record missing either one falls to `unknown` rather than guessing, so a region
string moves the score only when the record itself says what that string means.

The overall risk is the highest level any finding reached, with `unknown`
skipped rather than ranked, so one unclassifiable finding cannot drag down a
document that has real High findings. A document reads `unknown` overall only
when there was nothing else to go on.

There is no per-finding override. A score that reads wrong means the rule is
wrong and the rule gets changed.

## Validation

What is left to check once the agent stops writing derived fields:

- Does the draft parse against the schema, including the `providerId` and
  `ruleId` enums.
- Were all ten component categories reported on.
- Were all six policy points answered.
- Which citations were dropped, and which findings went with them.

Only the first of those is an error. A draft that doesn't parse leaves no
document, and that is the one case `runAssessment` asks again about. The rest
are warnings: the document stands, and says where it is incomplete.

What used to be here and is not any more: evidence-file existence, snippet
matching, and checking that a provider record the agent marked "found" had
actually been found. All three checked things the agent typed from memory, and
it no longer types any of them.

None of this verifies that evidence actually *supports* a finding, or that the
reasoning is sound. That would require the bespoke analysis this project
deliberately avoids building.

## In-loop review

Validation runs after the session is over. For a runtime that can't enforce the
schema on its own output, that is too late: it means accepting whatever arrives
and salvaging it. [`review.ts`](../src/assessment/review.ts) applies the same
narrowed schema as an accept/retry gate *inside* the agent's loop instead, while
the agent can still fix its answer and still has the provider list in front of
it. An invented `providerId` gets corrected there rather than resolving to
`no_record` an hour later.

It checks the shape and nothing else. Evidence used to be checked here too,
because the agent wrote the snippets; it doesn't, so there is nothing to catch.

`SwivalAgent` is the only adapter that needs it, and it drives the loop itself:
swival's own `--reviewer` flag does exactly this, but only around a
command-line task, and in `--acp` mode it parses and is then never invoked
(verified against swival 1.0.41 by a reviewer that logged every call and was
never called). `reviewUntilAcceptable` runs the same loop over `session/prompt`,
which does work. Three rounds by default, well under swival's 15, because each
round re-emits the whole assessment. A round that comes back unparseable is
discarded and the earlier answer kept, rather than trading down. It is also the
*only* correction mechanism swival has: `runAssessment`'s repair loop resumes a
session by id, and swival reports `agentCapabilities.loadSession: false`.

`ClaudeCodeAgent` skips the gate, because the SDK enforces `outputSchema`
natively. The two runtimes reach a conforming answer by different routes.

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
   corrective nudge. Once you have an answer, gate it with
   `reviewAssessmentOutput` before the session ends.
   [In-loop review](#in-loop-review) covers why that beats repairing it
   afterwards.
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

Six swival-specific behaviors were confirmed empirically (against swival
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
- `--reviewer` is accepted on the command line alongside `--acp` and is then
  never invoked in ACP mode; the docs' "requires a task" caveat means it only
  wraps a command-line task. `SwivalAgent` runs that loop itself over
  `session/prompt` instead (see [In-loop review](#in-loop-review)).
- `agentCapabilities.loadSession` is `false`, so there is no resuming a swival
  session by id. Anything that would be a second round trip has to happen
  inside the live session or not at all.
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
