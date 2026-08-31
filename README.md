# Sovereignty Graph

Sovereignty Graph performs data-sovereignty assessments of software
repositories, using an existing coding agent to do the actual investigation
instead of a bespoke static-analysis engine.

It launches and controls a coding agent (initially Claude Code, via the
Claude Agent SDK) against a repository and gives it a fixed assessment
methodology, along with the policy text and the list of provider records it
will need.

The agent reports observations: what moves data where, what kind of data,
which provider record applies, and where in the repository each claim can be
checked. Everything derived from those observations is computed afterwards in
code — the quoted evidence, the destination jurisdictions, the risk levels.
The agent does not write a score.

That split is the point. When the agent filled in every field itself, five
runs against the same commit produced 0, 4, 1, 5 and 4 high-risk findings.

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
| `--max-retries <n>` | How many times to ask again when the agent's answer doesn't match the schema (default 1; `0` disables) |
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

### What the agent decides, and what code decides

The agent makes four judgments per finding: that it is a finding at all, which
provider record applies, how the data is classified, and whether the code path
is the active one. Plus the prose.

Code does the rest:

- **Evidence.** The agent reports a file and a line range; the quoted text is
  read out of the repository. A fabricated quote is not expressible. A path
  that doesn't exist is dropped, and a finding whose citations were all dropped
  goes with them.
- **Jurisdiction.** Read off the provider record the agent named, never
  asserted by the agent.
- **Risk.** A pure function of the classification, the residency, and whether
  the path is active. The rule lives in
  [risk.ts](src/assessment/risk.ts) and every row of it has a test.
- **Coverage.** All ten component categories and all six policy points are
  enumerated and appear in every report, answered or not.

The provider id is an enum built from the record filenames, and the list is in
the agent's instructions. Asking for it as free text is what used to produce
`ches` for a record named `bcgov-ches`.

### Runtime differences

Claude Code constrains its final answer with `outputFormat: json_schema`, so a
malformed document can't be returned in the first place. swival has neither
that nor `agentCapabilities.loadSession`, so a session can't be resumed after
it ends. Instead `reviewUntilAcceptable` in [swival.ts](src/agents/swival.ts)
checks the answer against the same schema while the session is still open and
prompts for a correction until it passes.

Sampling is pinned to temperature 0 with a fixed seed on swival. The Claude
Agent SDK exposes no temperature, top-p or seed option, so that runtime runs at
the provider default.

## Development

```sh
npm run typecheck   # tsc --noEmit over src/, tests included
npm test            # node:test via tsx; no test framework dependency
npm run build       # tsconfig.build.json, which excludes *.test.ts from dist/
```

## Repository layout

```
src/
  agents/         CodingAgent interface + adapters (Claude Code and swival; Codex/Copilot placeholders)
  assessment/     the instructions given to the agent, and everything computed from its answer
    schema.ts           two shapes: the draft the agent returns, and the finished assessment
    methodology.ts      builds the brief: role, methodology, provider index, policy text
    hydrate-evidence.ts reads the cited line ranges out of the repository
    residency.ts        reads jurisdiction off the provider record the agent named
    risk.ts             the scoring rule, as a pure function
    assemble.ts         draft + knowledge base -> finished assessment
    validation.ts       does the draft parse, and was the ground covered
    review.ts           accept/retry gate applied to an answer before a session ends
    evidence-handle.ts  stable citation key for a file and line range
    nearest-path.ts     suggests the file a bad citation most likely meant
  knowledge/      read-only SG knowledge API over providers/ and policies/
  cli.ts          CLI entrypoint
  prompts.ts      loads prompts/ (role + methodology instructions)
  report.ts       Markdown report rendering
  run-assessment.ts  ties an agent, the methodology, and the derivation together

providers/       reference material on cloud/AI provider data residency; the risk score reads this
policies/        reference material on BC Government data-residency policy; inlined into every session
prompts/         the assessment methodology and role instructions given to the agent
examples/        example runs
docs/            architecture and design notes
```

## What Sovereignty Graph deliberately does not do

- No custom parsers, taint tracking, sink signatures, or Terraform/IaC
  parsing. The coding agent reads and reasons about the repository the way
  an engineer would.
- No provider-domain matching engine. The agent names the record that applies,
  from a list it is shown; code does not try to turn a vendor string into a
  record id. What code does with the record is read its residency fields.
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
