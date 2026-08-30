# Sovereignty Graph

Sovereignty Graph performs data-sovereignty assessments of software
repositories, using an existing coding agent to do the actual investigation
instead of a bespoke static-analysis engine.

It launches and controls a coding agent (initially Claude Code, via the
Claude Agent SDK) against a repository, gives it a fixed assessment
methodology, and lets it query trusted provider/policy reference material
on demand as it investigates. Its output must be a structured,
evidence-backed assessment that's then validated — including that every
provider/policy record it cites actually exists — before being turned into
a report.

See [`docs/architecture.md`](./docs/architecture.md) for the full design
rationale and pipeline.

## Status

Early. Two runtimes are implemented end to end: Claude Code (via the Claude
Agent SDK, in-process) and [swival](https://swival.dev) (via its `--acp`
mode, as a spawned child process — useful in particular for its local-model
providers, since an assessment can then run without any repository content
leaving the machine). Codex and Copilot adapters are placeholders — the
`CodingAgent` interface is designed to support them, but they're not built
yet.

## Install

```sh
npm install
npm run build
npm link
```

`npm link` puts a `sovereignty-graph` command on your PATH, symlinked to
this checkout's `dist/`. Rebuilding (`npm run build`) is picked up
automatically; no need to re-link. Skip this step and use `node dist/cli.js`
directly if you'd rather not touch global npm state.

## Usage

```sh
sovereignty-graph assess <path-to-repository> [options]
```

Options:

| Flag | Description |
| --- | --- |
| `-a, --agent <runtime>` | Coding agent runtime to run the assessment with: `claude-code` (default) or `swival` |
| `-m, --model <model>` | Model identifier to pass to the coding agent |
| `-r, --resume <sessionId>` | Resume a previous assessment session |
| `-o, --out <file>` | Write the Markdown report to a file instead of stdout |
| `--json <file>` | Also write the raw structured assessment as JSON |
| `--html [file]` | Also write an HTML report and open it automatically once the assessment completes. If `file` is omitted, it's written to `./output/` (gitignored). |
| `--no-open` | With `--html`, write the HTML report but don't open it |
| `--max-repair-rounds <n>` | How many times to hand unverifiable evidence citations back to the agent to correct (default 2; `0` disables) |
| `-q, --quiet` | Suppress progress output |

Requires Claude Code SDK authentication to be configured in your
environment — see the
[Claude Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
for supported auth methods.

### As a library

```ts
import { ClaudeCodeAgent, runAssessment, renderMarkdownReport } from "sovereignty-graph";

const { agentResult, validation } = await runAssessment({
  agent: new ClaudeCodeAgent(),
  repositoryPath: "/path/to/repo",
});

if (validation.assessment) {
  console.log(renderMarkdownReport(validation.assessment, validation));
}
```

### Evidence verification

Every `evidence[]` entry a finding cites is checked against the repository
after the session: the file must exist, and the `snippet` must actually appear
in it. A citation the agent produced through `sg_cite_evidence` also carries an
`evidenceId`, which only re-derives from the real text at the cited lines.

Citations that fail are handed back to the same session to correct, up to
`--max-repair-rounds` times. Anything still unverified is marked on the
specific evidence line and finding in the report, rather than discrediting the
whole assessment. Findings are never dropped for a bad citation: a fabricated
reference does not make the finding wrong, so the report flags it and leaves
the judgement to a reader.

The two agent runtimes reach that point differently. Claude Code constrains its
final answer with `outputFormat: json_schema`, so a malformed document can't be
returned in the first place, and `--max-repair-rounds` resumes the session to
fix citations. swival has neither: no schema-constrained output, and
`agentCapabilities.loadSession: false`, so a session can't be resumed after it
ends. Instead `reviewUntilAcceptable` in
[swival.ts](src/agents/swival.ts) reviews the answer against the same schema and
evidence rules while the session is still open, and prompts for a correction
until it passes. That is what keeps a null in an optional field, or a
hallucinated citation, from ending the run.

## Development

```sh
npm run typecheck   # tsc --noEmit over src/, tests included
npm test            # node:test via tsx; no test framework dependency
npm run build       # tsconfig.build.json, which excludes *.test.ts from dist/
```

## Repository layout

```
src/
  agents/         CodingAgent interface + adapters (Claude Code implemented; Codex/Copilot placeholders)
    sg-tools.ts   exposes SG knowledge to Claude Code as MCP tools (sg_search_providers, ...)
    sg-repo-tool-defs.ts  sg_cite_evidence: reads a line range and mints its citation handle
  assessment/     methodology (instructions-only), structured assessment schema, validation
    validation.ts       evidence/provider/policy checking, per-finding taint
    review.ts           accept/retry gate applied to an answer before a session ends
    evidence-handle.ts  mints and re-derives the sg_cite_evidence handle
    nearest-path.ts     suggests the file a bad citation most likely meant
    repair.ts           builds the follow-up prompt for an evidence repair round
  knowledge/      read-only SG knowledge API: searchProviders/getProvider, searchPolicies/getPolicy, ...
  cli.ts          CLI entrypoint
  prompts.ts      loads prompts/ (role + methodology instructions)
  report.ts       Markdown report rendering
  run-assessment.ts  ties an agent, the methodology, and validation together

providers/       trusted reference material on cloud/AI provider data residency, queried on demand
policies/        trusted reference material on BC Government data-residency policy, queried on demand
prompts/         the assessment methodology and role instructions given to the agent
examples/        example runs
docs/            architecture and design notes
```

## What Sovereignty Graph deliberately does not do

- No custom parsers, taint tracking, sink signatures, or Terraform/IaC
  parsing. The coding agent reads and reasons about the repository the way
  an engineer would.
- No provider-domain matching engine. Provider data-residency
  characteristics live in [`providers/`](./providers/) as reference
  material the agent queries on demand (via `sg_search_providers` /
  `sg_get_provider`), not as code that pattern-matches domains, and not as
  content preloaded into every session's opening instructions.
- No legal or compliance determination. Assessments are technical,
  evidence-backed findings meant to help a human reviewer decide where to
  look closer — see the caveats in [`policies/README.md`](./policies/README.md).

## Security note

Assessment sessions run with `Read`, `Grep`, `Glob`, and `Bash` tools and
`bypassPermissions` (there's no human in the loop to approve prompts in a
headless run). `Bash` means the agent can run arbitrary shell commands
within the repository's working directory. Treat repositories you assess as
at least semi-trusted, or run assessments inside a container or read-only
checkout.

The swival runtime is a weaker version of the same posture: swival's
built-in sandbox only offers a whole-workspace file-access tri-state
(`none` / `some` / `all`; there's no read-only variant for the working
directory itself — `--add-dir-ro` only grants extra directories beyond it),
so `SwivalAgent` cannot hard-exclude write/edit tools the way the Claude
Code adapter excludes them at the tool-list level. It instead relies on an
instruction in the prompt asking the agent not to modify files — a policy,
not an enforced restriction. (Where that instruction sits in the prompt
matters: placed mid-prompt, ahead of the JSON-schema instructions, a small
local model still went ahead and wrote and deleted a file during testing;
moved to the very end of the prompt, immediately before the model answers,
the same model stopped doing so. `SwivalAgent` places it last for this
reason, but a prompt instruction can still be ignored by a different or
more adversarial model.) Apply the same semi-trusted-repository caution
here, or pass `--sandbox nono`/`agentfs` yourself if you need OS-enforced
read-only access.

Observed in testing: even with `--no-history`/`--no-continue`/`--no-memory`/
`--no-skills` all passed, swival still creates a `.swival/` directory in the
assessed repository the moment the agent deletes a file — swival routes
deletes through a `.swival/trash/` safety net rather than an OS-level
`unlink`, and there's no flag to turn that off. It's a genuine safety
feature, but it means a swival-run assessment can leave a stray `.swival/`
behind in someone else's repository; clean it up (or run against a
disposable checkout) if that matters for your use case.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
