import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { hydrateEvidence, parseLineRange } from "./hydrate-evidence.js";

const FILE = "src/mail/send.ts";
const LINES = ["import { Twilio } from 'twilio';", "", "export function send() {", "  return 1;", "}"];

let repositoryPath: string;
const files = [FILE];

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-hydrate-"));
  const absolute = join(repositoryPath, FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, LINES.join("\n"), "utf8");
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function hydrate(items: { file: string; lines: string; note?: string }[]) {
  return hydrateEvidence(items, "f", repositoryPath, files);
}

test("quotes the cited range out of the file", async () => {
  const result = await hydrate([{ file: FILE, lines: "3-5", note: "the send path" }]);

  assert.equal(result.dropped.length, 0);
  assert.equal(result.evidence[0]?.snippet, "export function send() {\n  return 1;\n}");
  assert.equal(result.evidence[0]?.lines, "3-5");
  assert.equal(result.evidence[0]?.note, "the send path");
  assert.match(result.evidence[0]?.evidenceId ?? "", /^ev_[0-9a-f]{16}$/);
});

test("a single line number works as a range", async () => {
  const result = await hydrate([{ file: FILE, lines: "1" }]);

  assert.equal(result.evidence[0]?.snippet, LINES[0]);
  assert.equal(result.evidence[0]?.lines, "1");
});

test("a range running past the end is clamped, not dropped", async () => {
  // Off-by-a-few at the end of a file says nothing about whether the agent read
  // it, so the citation stands and quotes what is actually there.
  const result = await hydrate([{ file: FILE, lines: "4-99" }]);

  assert.equal(result.dropped.length, 0);
  assert.equal(result.evidence[0]?.lines, "4-5");
});

test("a range starting past the end is dropped", async () => {
  const result = await hydrate([{ file: FILE, lines: "80-90" }]);

  assert.equal(result.evidence.length, 0);
  assert.equal(result.dropped[0]?.reason, "lines_out_of_range");
});

test("a missing file is dropped, with the nearest real path recorded", async () => {
  const result = await hydrate([{ file: "src/mailer/send.ts", lines: "1" }]);

  assert.equal(result.evidence.length, 0);
  assert.equal(result.dropped[0]?.reason, "file_missing");
  assert.equal(result.dropped[0]?.suggestion, FILE);
});

test("an absolute path is dropped, and resolved to a suggestion when it is in the repo", async () => {
  const result = await hydrate([{ file: join(repositoryPath, FILE), lines: "1" }]);

  assert.equal(result.dropped[0]?.reason, "absolute_path");
  assert.equal(result.dropped[0]?.suggestion, FILE);
});

test("a path escaping the repository is dropped", async () => {
  const result = await hydrate([{ file: "../../etc/passwd", lines: "1" }]);

  assert.equal(result.dropped[0]?.reason, "outside_repository");
});

test("an unparseable range is dropped", async () => {
  const result = await hydrate([{ file: FILE, lines: "somewhere near the top" }]);

  assert.equal(result.dropped[0]?.reason, "lines_unparseable");
});

test("good and bad citations in one finding are separated", async () => {
  const result = await hydrate([
    { file: FILE, lines: "1" },
    { file: "nope.ts", lines: "1" },
  ]);

  assert.equal(result.evidence.length, 1);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]?.path, "f.evidence[1]", "the drop keeps its position in the draft");
});

test("the same range always mints the same id", async () => {
  const first = await hydrate([{ file: FILE, lines: "1" }]);
  const second = await hydrate([{ file: FILE, lines: "1" }]);

  assert.equal(first.evidence[0]?.evidenceId, second.evidence[0]?.evidenceId);
});

test("parseLineRange reads the forms an agent actually writes", () => {
  assert.deepEqual(parseLineRange("12"), { start: 12, end: 12 });
  assert.deepEqual(parseLineRange("12-18"), { start: 12, end: 18 });
  assert.deepEqual(parseLineRange("L12-L18"), { start: 12, end: 18 });
  assert.deepEqual(parseLineRange("18-12"), { start: 12, end: 18 }, "reversed ranges are normalized");
  assert.deepEqual(parseLineRange("12–18"), { start: 12, end: 18 }, "en dash");
  assert.equal(parseLineRange("the imports"), undefined);
});
