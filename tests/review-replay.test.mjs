import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replayReviews } from "../scripts/ai-capture/review-replay.mjs";

test("review replay reviews each valid writer question once per setting and resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-replay-"));
  const runDir = join(root, "writer-run");
  mkdirSync(runDir);
  const cases = join(root, "generate.json");
  writeFileSync(
    cases,
    JSON.stringify([
      { id: "a", payload: { contract: { depth: 1 } } },
      { id: "b", payload: { contract: { depth: 2 } } },
    ]),
  );
  writeFileSync(
    join(runDir, "results.jsonl"),
    [
      { caseId: "a", rep: 0, outcome: "valid", answers: [{ title: "A" }] },
      { caseId: "b", rep: 0, outcome: "invalid", answers: [] },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const seen = [];
  const gateway = {
    review: async (payload, answer, reviewer) => {
      seen.push(`${reviewer.model}:${reviewer.effort}/${answer.title}`);
      return {
        answer: { ...answer, title: "A2" },
        review: "revised",
        changes: ["x"],
        meta: { costUsd: 0.01, model: "claude-sonnet-5-5" },
      };
    },
  };
  const out = join(root, "out");
  const args = {
    sources: [`${runDir}=${cases}`],
    settings: ["sonnet:medium", "opus:high"],
    out,
    gateway,
  };
  assert.equal((await replayReviews(args)).ran, 2);
  assert.deepEqual(seen.sort(), ["opus:high/A", "sonnet:medium/A"]);
  const rows = readFileSync(join(out, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows
      .map((r) => [r.run, r.caseId, r.setting, r.review, r.answer.title])
      .sort(),
    [
      ["writer-run", "a", "opus:high", "revised", "A2"],
      ["writer-run", "a", "sonnet:medium", "revised", "A2"],
    ],
  );
  assert.equal((await replayReviews(args)).ran, 0, "resumes");
  await assert.rejects(
    replayReviews({ ...args, settings: ["opus:high+sonnet:low"] }),
    /one model:effort/,
  );
});
