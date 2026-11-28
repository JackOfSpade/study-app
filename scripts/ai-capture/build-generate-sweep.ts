#!/usr/bin/env node
/**
 * Build `generate` cases the way the learner actually studies: the live
 * profile with the product-engineer career focus, one case per core
 * Product Engineering topic and depth. The app's own scheduler picks the
 * objective and the app's own payload builder writes the request, against a
 * stub bridge, so no network is used. A ladder run over these cases shows what
 * the generator writes today, which `--check` style judging can then read.
 *
 * tsx scripts/ai-capture/build-generate-sweep.ts --out <dir> [--count N] [--offset K]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBridge, ensureProblem } from "../../src/ai";
import { activateCareerFocus, CORE_IDS } from "../../src/career-profile";
import { eligible } from "../../src/curriculum";
import type { Contract, Roadmap } from "../../src/model";
import {
  encounterFor,
  recordFor,
  roadmap,
  withBridge,
} from "./build-study-cases";
import { argument, topicOf, writeCaseFiles } from "./case-files";

/** The core PE topics in the order the profile lists them, each once. */
export const SWEEP_TOPICS = [
  ...new Set(CORE_IDS.filter((id) => id.startsWith("PE:")).map(topicOf)),
];

/** The generate payload the app sends for a fresh live, career-focused
 * record whose PE queue is at `topic` and `depth`. */
export async function sweepPayload(
  r: Roadmap,
  topic: string,
  depth: number,
): Promise<Record<string, unknown>> {
  const g = recordFor(r);
  activateCareerFocus(r, g.study);
  const learner = g.study.learner!;
  learner.reviews = {};
  learner.studyTurnPosition = 1;
  learner.tracks.PE.tier = depth;
  learner.tracks.PE.queue = [topic];
  const e = encounterFor(g, 0);
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation !== "generate") return { text: "unused", complete: false };
      captured = payload;
      // Any well-formed problem lets the flow finish; only the request matters.
      const contract = payload.contract as Contract;
      return {
        title: "Captured request",
        prompt: "Unused.",
        starter: "",
        rubric: ["Unused."],
        provenance: "claude-cli",
        contract,
        estimatedSolveSeconds: 300,
      };
    },
    async () => {
      // The scheduler may move past the queued topic; record what it chose.
      eligible(r, g.study);
      await ensureProblem(g, e, r);
    },
  );
  if (!captured)
    throw Error(`generate flow did not call the bridge (${topic} D${depth})`);
  return captured;
}

export async function buildGenerateSweep({
  count = 12,
  offset = 0,
}: { count?: number; offset?: number } = {}) {
  const r = roadmap();
  await withBridge(
    () => ({ text: "unused", complete: false }),
    async () => {
      await checkBridge();
    },
  );
  const cases: {
    id: string;
    operation: "generate";
    payload: Record<string, unknown>;
  }[] = [];
  const seen = new Set<string>();
  for (let i = offset; cases.length < count && i < offset + count * 4; i++) {
    const topic = SWEEP_TOPICS[i % SWEEP_TOPICS.length];
    const depth = 1 + ((Math.floor(i / SWEEP_TOPICS.length) + i) % 3);
    const payload = await sweepPayload(r, topic, depth);
    const contract = payload.contract as Contract;
    const key = `${contract.objectiveIds.join(",")}@${contract.depth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({
      id: `sweep-${String(cases.length + 1).padStart(2, "0")}-${contract.objectiveIds[0]?.replace(":", "-")}-D${contract.depth}`,
      operation: "generate",
      payload,
    });
  }
  return cases;
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const out = argument("--out")!;
  if (!out) throw Error("Pass --out <dir>");
  const count = Number(argument("--count", "12"));
  const offset = Number(argument("--offset", "0"));
  buildGenerateSweep({ count, offset }).then(
    (cases) => {
      writeCaseFiles(
        out,
        { "generate.json": cases },
        { generate: cases.length },
      );
      console.log(`Wrote ${cases.length} generate cases to ${resolve(out)}:`);
      for (const c of cases) console.log(`  ${c.id}`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
