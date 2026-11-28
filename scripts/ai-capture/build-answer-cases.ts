#!/usr/bin/env node
/**
 * Build `tutor` and `assess` cases that test how a generated question is
 * judged downstream, from fixed learner answers. Each item is one question
 * (as `generate` returned it) with the shortest correct answer to every part
 * and a flawed answer to part 1. The app's real flow runs against the stub
 * bridge: `ensureProblem` stores the question exactly as production does,
 * `send` carries each answer, and completing the last part triggers the real
 * `assess` request. No network is used.
 *
 * Cases per item:
 * - tutor `<id>--correct-p1`: the correct part-1 answer; a fair tutor accepts it.
 * - tutor `<id>--flawed-p1`: the flawed part-1 answer; a fair tutor keeps it open.
 * - assess `<id>--correct-all`: every part answered correctly and confirmed;
 *   a fair assessor marks the answered facets independent.
 * - assess `<id>--flawed-accepted`: part 1 flawed but (wrongly) confirmed,
 *   the rest correct; the assessor must still not credit part 1's facet.
 *
 * tsx scripts/ai-capture/build-answer-cases.ts --items <items.json> --out <dir>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBridge, ensureProblem, send } from "../../src/ai";
import type { Contract, Roadmap } from "../../src/model";
import { advancePart } from "../../src/question-parts";
import { roadmap, withBridge } from "./build-study-cases";
import { argument, topicOf, writeCaseFiles } from "./case-files";
import { sweepRecord } from "./build-generate-sweep";

export type AnswerItem = {
  id: string;
  /** The question as `generate` returned it (prompt, parts, rubric, ...). */
  problem: Record<string, unknown> & { contract: Contract; parts?: string[] };
  /** The shortest complete correct answer to each part, in order. */
  correct: string[];
  /** An answer to part 1 with one material error. */
  flawed: string;
};

type Case = { id: string; operation: string; payload: Record<string, unknown> };

const NO_HELP = { nudges: [], hints: [], gives: [], offers: [] };

/** A record holding `item.problem` as its open question, issued through the
 * real generate flow so it is normalised and staged as production does. */
async function issued(r: Roadmap, item: AnswerItem) {
  const contract = item.problem.contract;
  const { g, e } = sweepRecord(
    r,
    topicOf(contract.objectiveIds[0]),
    contract.depth,
  );
  await withBridge(
    (operation, payload) =>
      operation === "generate"
        ? {
            ...structuredClone(item.problem),
            provenance: "claude-cli",
            contract: payload.contract,
          }
        : { text: "unused", complete: false },
    () => ensureProblem(g, e, r),
  );
  if (!e.problem)
    throw Error(
      `${item.id}: the question was not issued: ${e.error ?? "no error"}`,
    );
  return { g, e };
}

/** Answer part 1 and capture the tutor request it sends. */
async function tutorCase(r: Roadmap, item: AnswerItem, answer: string) {
  const { g, e } = await issued(r, item);
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation === "tutor") captured ??= payload;
      return { help: NO_HELP, text: "Noted.", complete: false };
    },
    () => send(g, e, answer, r),
  );
  if (!captured) throw Error(`${item.id}: no tutor request`);
  return captured;
}

/** Answer every part, each confirmed by the stub tutor, and capture the
 * assess request the completion sends. */
async function assessCase(r: Roadmap, item: AnswerItem, answers: string[]) {
  const { g, e } = await issued(r, item);
  let captured: Record<string, unknown> | undefined;
  const parts = e.problem!.staged?.parts.length ?? 1;
  await withBridge(
    (operation, payload) => {
      if (operation === "assess") {
        captured ??= payload;
        return {
          findings: [],
          visitOutcome: "unresolved",
          scopeReviews: [],
          helpAttributions: [],
        };
      }
      const last =
        (payload.stage as { part?: number } | undefined)?.part === undefined
          ? true
          : (payload.stage as { part: number; of: number }).part >=
            (payload.stage as { of: number }).of;
      return last
        ? { help: NO_HELP, text: "Correct.", complete: true, outcome: "solved" }
        : {
            help: NO_HELP,
            text: "Correct.",
            complete: false,
            partComplete: true,
          };
    },
    async () => {
      for (let i = 0; i < parts; i++) {
        await send(g, e, answers[i] ?? answers.at(-1)!, r);
        if (i < parts - 1 && !advancePart(e))
          throw Error(`${item.id}: part ${i + 1} was not confirmed`);
      }
      // The completion starts the assessment without awaiting it.
      for (let wait = 0; !captured && wait < 100; wait++)
        await new Promise((done) => setTimeout(done, 10));
    },
  );
  if (!captured) throw Error(`${item.id}: no assess request`);
  return captured;
}

export async function buildAnswerCases(items: AnswerItem[]) {
  const r = roadmap();
  await withBridge(
    () => ({ text: "unused", complete: false }),
    async () => {
      await checkBridge();
    },
  );
  const tutor: Case[] = [];
  const assess: Case[] = [];
  for (const item of items) {
    tutor.push({
      id: `${item.id}--correct-p1`,
      operation: "tutor",
      payload: await tutorCase(r, item, item.correct[0]),
    });
    tutor.push({
      id: `${item.id}--flawed-p1`,
      operation: "tutor",
      payload: await tutorCase(r, item, item.flawed),
    });
    assess.push({
      id: `${item.id}--correct-all`,
      operation: "assess",
      payload: await assessCase(r, item, item.correct),
    });
    assess.push({
      id: `${item.id}--flawed-accepted`,
      operation: "assess",
      payload: await assessCase(r, item, [
        item.flawed,
        ...item.correct.slice(1),
      ]),
    });
  }
  return { tutor, assess };
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const itemsFile = argument("--items");
  const out = argument("--out");
  if (!itemsFile || !out) throw Error("Pass --items <items.json> --out <dir>");
  const items = JSON.parse(
    readFileSync(resolve(itemsFile), "utf8"),
  ) as AnswerItem[];
  buildAnswerCases(items).then(
    ({ tutor, assess }) => {
      writeCaseFiles(
        out,
        { "tutor.json": tutor, "assess.json": assess },
        { tutor: tutor.length, assess: assess.length },
      );
      console.log(
        `Wrote ${tutor.length} tutor and ${assess.length} assess cases to ${resolve(out)}.`,
      );
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
