#!/usr/bin/env node
/**
 * Run only the generate review stage over questions a ladder run already
 * wrote, once per reviewer setting. Every setting reviews the same writer
 * output, so the comparison is paired: what changes between arms is the
 * reviewer alone, not the luck of the writer.
 *
 * node scripts/ai-capture/review-replay.mjs --source <run dir>=<case file>[,...]
 *   --settings sonnet:medium,opus:high --out <dir> [--parallel 4]
 *
 * Writes <out>/results.jsonl, one row per source question and setting, and
 * resumes: a row already written is not reviewed again. Real Claude CLI calls.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseList, parseSetting } from "../ai-ladder.mjs";
import { createClaudeGateway } from "../claude-gateway.mjs";
import { privateDirectory } from "../lib/private-fs.mjs";

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];

/** Every valid writer question of the given runs with its case payload. */
export function sourceQuestions(sources) {
  const questions = [];
  for (const source of sources) {
    const [runDir, caseFile] = source.split("=");
    if (!runDir || !caseFile)
      throw Error(`--source needs <run dir>=<case file>, got "${source}"`);
    const payloads = new Map(
      JSON.parse(readFileSync(resolve(caseFile), "utf8")).map((c) => [
        c.id,
        c.payload,
      ]),
    );
    const run = runDir.replace(/\/+$/, "").split("/").at(-1);
    for (const row of readJsonl(join(resolve(runDir), "results.jsonl"))) {
      const answer = row.answers?.at(-1);
      const payload = payloads.get(row.caseId);
      if (row.outcome !== "valid" || !answer || !payload) continue;
      questions.push({
        run,
        caseId: row.caseId,
        rep: row.rep,
        payload,
        answer,
      });
    }
  }
  return questions;
}

export async function replayReviews({
  sources,
  settings,
  out,
  parallel = 4,
  gateway = createClaudeGateway({ maxRunning: parallel }),
}) {
  privateDirectory(out);
  const resultsFile = join(out, "results.jsonl");
  const key = (row) =>
    `${row.run}\u0000${row.caseId}\u0000${row.rep}\u0000${row.setting}`;
  const done = new Set(readJsonl(resultsFile).map(key));
  const jobs = [];
  for (const question of sourceQuestions(sources))
    for (const value of settings) {
      const setting = parseSetting(value);
      if (setting.review)
        throw Error(`A reviewer is one model:effort, got ${value}`);
      const job = { ...question, setting: setting.setting, reviewer: setting };
      if (!done.has(key(job))) jobs.push(job);
    }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await gateway.review(job.payload, job.answer, {
        model: job.reviewer.model,
        effort: job.reviewer.effort,
      });
      appendFileSync(
        resultsFile,
        `${JSON.stringify({
          run: job.run,
          caseId: job.caseId,
          rep: job.rep,
          setting: job.setting,
          review: result.review,
          changes: result.changes,
          problem: result.problem,
          model: result.meta?.model ?? null,
          costUsd: result.meta?.costUsd ?? null,
          durationMs: result.meta?.durationMs ?? null,
          contract: job.payload.contract,
          answer: result.answer,
        })}\n`,
        { mode: 0o600 },
      );
      console.log(`${job.setting} ${job.run}/${job.caseId}: ${result.review}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return { resultsFile, ran: jobs.length };
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const sources = parseList(arg("--source"));
  const settings = parseList(arg("--settings"));
  const out = arg("--out");
  if (!sources.length || !settings.length || !out)
    throw Error(
      "Usage: review-replay.mjs --source <run dir>=<case file>[,...] --settings a,b --out <dir> [--parallel N]",
    );
  replayReviews({
    sources,
    settings,
    out: resolve(out),
    parallel: Number(arg("--parallel") ?? 4),
  }).then(
    ({ resultsFile, ran }) => console.log(`${ran} review(s) -> ${resultsFile}`),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
