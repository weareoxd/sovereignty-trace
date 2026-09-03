# Examples

Sovereignty Trace works against any local repository. There's no bundled
sample repository yet — the simplest way to see it end to end is to run it
against this project itself, since it's a small, self-contained TypeScript
codebase with a couple of real external integrations to find (the Claude
Agent SDK call, filesystem access):

```sh
npm install
npm run build
node dist/cli.js assess . --out examples/self-assessment.md --json examples/self-assessment.json
```

This requires Claude Code SDK auth to be configured in your environment
(the same auth `@anthropic-ai/claude-agent-sdk` uses for any session — see
its documentation for supported auth methods).

Once you have a report you're happy with, replace this file with a real
example (a small anonymized or synthetic repository plus its
`assess` output) so newcomers have something concrete to look at without
running the tool themselves.
