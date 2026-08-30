import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestNearestPath } from "./nearest-path.js";

// The paths from the common-notify run that motivated this check.
const COMMON_NOTIFY_FILES = [
  "backend/src/auth/auth.jwt-strategy.ts",
  "backend/src/auth/auth.jwt-guard.ts",
  "backend/src/auth/auth.module.ts",
  "backend/src/common/interceptors/logging.interceptor.ts",
  "backend/src/app.module.ts",
  "frontend/src/main.ts",
];

test("suggests the real file when only the directory was wrong", () => {
  assert.equal(
    suggestNearestPath("backend/src/common/guards/auth.jwt-strategy.ts", COMMON_NOTIFY_FILES),
    "backend/src/auth/auth.jwt-strategy.ts",
  );
});

test("picks the closest path when several files share a basename", () => {
  const files = ["a/deep/nested/config.ts", "backend/src/config.ts", "x/y/z/q/config.ts"];
  assert.equal(suggestNearestPath("backend/src/app/config.ts", files), "backend/src/config.ts");
});

test("falls back to the same filename with a different extension", () => {
  const files = ["backend/src/auth/auth.jwt-strategy.js"];
  assert.equal(
    suggestNearestPath("backend/src/auth/auth.jwt-strategy.ts", files),
    "backend/src/auth/auth.jwt-strategy.js",
  );
});

test("suggests a near-miss path when the filename itself was slightly wrong", () => {
  assert.equal(
    suggestNearestPath("backend/src/auth/auth.jwt-strategies.ts", COMMON_NOTIFY_FILES),
    "backend/src/auth/auth.jwt-strategy.ts",
  );
});

test("returns nothing rather than a bad guess", () => {
  assert.equal(suggestNearestPath("infra/terraform/s3.tf", COMMON_NOTIFY_FILES), undefined);
});

test("does not offer an unrelated file that happens to be a short edit away", () => {
  // "nope.ts" and "index.ts" are close as strings and unrelated as files.
  assert.equal(
    suggestNearestPath("backend/src/nope.ts", ["backend/src/index.ts", "backend/src/main.ts"]),
    undefined,
  );
});

test("handles an empty repository", () => {
  assert.equal(suggestNearestPath("anything.ts", []), undefined);
});

test("normalizes a leading ./ before matching", () => {
  assert.equal(
    suggestNearestPath("./backend/src/common/guards/auth.jwt-strategy.ts", COMMON_NOTIFY_FILES),
    "backend/src/auth/auth.jwt-strategy.ts",
  );
});
