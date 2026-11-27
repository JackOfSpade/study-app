#!/usr/bin/env node
/**
 * Build downstream `tutor` and `assess` cases on questions a real `generate`
 * ladder arm produced. The app's real payload builders run against the same
 * stub bridge as build-study-cases.ts, so no network or model is needed.
 *
 * tsx scripts/ai-capture/build-downstream-cases.ts \
 *   --results <results.jsonl> --generate-cases <generate.json> \
 *   --setting <model:effort> --rep <n> --out <dir>
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assess, checkBridge, edit, send } from "../../src/ai";
import type {
  Contract,
  Encounter,
  StudyRecord,
  Problem,
  Roadmap,
} from "../../src/model";
import {
  contractFor,
  encounterFor,
  recordFor,
  roadmap,
  scenarioFor,
  withBridge,
  type StudyCase,
} from "./build-study-cases";
import {
  argument,
  lastValidAnswer,
  parseLadderSetting,
  readJsonlRows,
  topicOf,
  writeCaseFiles,
  type LadderRow,
} from "./case-files";

export type { LadderRow };

/** The one learner turn every downstream tutor case carries. */
export const TUTOR_MESSAGE =
  "I've read it. Where should I start, and what is the key thing to get right?";
/** The honest note left in the partial attempt the assess case reviews. */
export const ASSESS_ATTEMPT_NOTE =
  "# attempt: I handled the main case but have not checked the boundary yet.";

export type GenerateCase = {
  id: string;
  operation: "generate";
  payload: Record<string, unknown>;
};

type DownstreamCaseBook = {
  tutor: StudyCase[];
  assess: StudyCase[];
  skipped: string[];
};

/** The generated answer as a Problem: everything but `text`, plus provenance. */
export function problemFrom(answer: unknown): Problem {
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    throw Error("Generated answer is not an object");
  const { text: _text, ...rest } = answer as Record<string, unknown>;
  if (!rest.contract || typeof rest.contract !== "object")
    throw Error("Generated answer carries no contract");
  for (const key of ["title", "prompt"] as const)
    if (typeof rest[key] !== "string" || !rest[key])
      throw Error(`Generated answer has no ${key}`);
  // Conceptual questions legitimately have an empty starter.
  if (typeof rest.starter !== "string")
    throw Error("Generated answer has no starter");
  if (!Array.isArray(rest.rubric))
    throw Error("Generated answer has no rubric");
  return { ...rest, provenance: "claude-cli" } as unknown as Problem;
}

/**
 * A record and encounter built exactly the way buildTutor/buildAssess build
 * them, except that the problem is the generated one. The scenario and
 * encounter follow the generate case's index, so an arm's cases stay
 * reproducible.
 */
function encounterForProblem(r: Roadmap, index: number, problem: Problem) {
  const generated = problem.contract;
  const scenario = scenarioFor(generated, index);
  const g = recordFor(r);
  const e = encounterFor(g, index);
  const scheduled = contractFor(
    g,
    r,
    {
      ...scenario,
      track: generated.track,
      topic: topicOf(generated.objectiveIds[0]),
    },
    generated.depth,
    index,
  );
  if (
    scheduled.track !== generated.track ||
    JSON.stringify(scheduled.objectiveIds) !==
      JSON.stringify(generated.objectiveIds)
  )
    bindGeneratedContract(g, generated);
  e.problem = problem;
  return { g, e };
}

/**
 * A cheaper generate arm may ask for work the local roadmap did not schedule
 * next. The generated contract wins: bind the learner's next visit to it so
 * the encounter and its captured payload describe one consistent task.
 */
function bindGeneratedContract(g: StudyRecord, generated: Contract) {
  const learner = g.study.learner!;
  learner.studyTurnPosition = generated.track === "PY" ? 0 : 1;
  learner.tracks[generated.track].tier = generated.depth;
  learner.tracks[generated.track].queue = [topicOf(generated.objectiveIds[0])];
  delete g.study.pending;
}

/** One learner turn through real `send`, captured from the stub bridge. */
async function captureTutor(g: StudyRecord, e: Encounter, r: Roadmap) {
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation !== "tutor") return { text: "unused", complete: false };
      captured ??= payload;
      return {
        text: "Start from the state you keep between steps, then say when an answer becomes eligible.",
        complete: false,
      };
    },
    () => send(g, e, TUTOR_MESSAGE, r),
  );
  if (!captured) throw Error(`Tutor flow did not call the bridge for ${e.id}`);
  return captured;
}

/** One honest partial attempt reviewed by the real `assess`, as buildAssess does. */
async function captureAssess(
  g: StudyRecord,
  e: Encounter,
  r: Roadmap,
  problem: Problem,
) {
  const attempt = `${problem.starter}\n${ASSESS_ATTEMPT_NOTE}\n`;
  // buildAssess records the human's work through the real `edit`; the packet
  // only carries the workspace snapshot at the cutoff, not the submission.
  e.workspace = problem.starter;
  edit(g, e, attempt, e.revision, r);
  const submission = {
    id: `submission-${e.id}`,
    revision: e.revision,
    author: "human",
    content: attempt,
    status: "needs-work" as const,
    feedback: "",
    seq: ++g.seq,
  };
  e.submissions.push(submission);
  let captured: Record<string, unknown> | undefined;
  await withBridge(
    (operation, payload) => {
      if (operation === "assess") captured ??= payload;
      return { findings: [], visitOutcome: "unresolved" };
    },
    () => assess(g, e, r, submission.seq),
  );
  if (!captured) throw Error(`Assess flow did not call the bridge for ${e.id}`);
  return captured;
}

type BuildDownstreamOptions = {
  rows: LadderRow[];
  generateCases: GenerateCase[];
  setting: string;
  rep: number;
};

/**
 * Build `tutor` and `assess` cases from the valid generate rows of one ladder
 * arm. Case ids depend only on the generate case id, so two arms pair by id.
 */
export async function buildDownstreamCases({
  rows,
  generateCases,
  setting,
  rep,
}: BuildDownstreamOptions): Promise<DownstreamCaseBook> {
  const r = roadmap();
  await withBridge(
    () => ({ text: "unused", complete: false }),
    async () => {
      await checkBridge();
    },
  );
  const book: DownstreamCaseBook = { tutor: [], assess: [], skipped: [] };
  for (const [index, generateCase] of generateCases.entries()) {
    const answer = lastValidAnswer(rows, {
      caseId: generateCase.id,
      operation: "generate",
      setting,
      rep,
    });
    if (answer === undefined) {
      book.skipped.push(generateCase.id);
      continue;
    }
    const problem = problemFrom(answer);
    const tutorRun = encounterForProblem(r, index, problem);
    book.tutor.push({
      id: `tutor-from-${generateCase.id}`,
      operation: "tutor",
      payload: await captureTutor(tutorRun.g, tutorRun.e, r),
    });
    const assessRun = encounterForProblem(r, index, problem);
    book.assess.push({
      id: `assess-from-${generateCase.id}`,
      operation: "assess",
      payload: await captureAssess(assessRun.g, assessRun.e, r, problem),
    });
  }
  return book;
}

/**
 * Write tutor.json and assess.json with the same permissions as study cases.
 * A run that pairs no generate row writes nothing, so a typo'd setting or
 * wrong rep never replaces earlier cases with empty files.
 */
export async function writeDownstreamCases(
  out: string,
  results: string,
  options: BuildDownstreamOptions,
) {
  const book = await buildDownstreamCases(options);
  if (book.tutor.length === 0)
    throw Error(
      `No valid generate rows in ${results} paired with these generate cases at ${options.setting} rep ${options.rep}; nothing written.`,
    );
  writeCaseFiles(out, { "tutor.json": book.tutor, "assess.json": book.assess });
  return book;
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const resultsFile = argument("--results");
  const generateFile = argument("--generate-cases");
  const settingText = argument("--setting");
  const repText = argument("--rep");
  const out = argument("--out", ".local/ai-downstream")!;
  if (!resultsFile || !generateFile || !settingText || !repText)
    throw Error(
      "--results, --generate-cases, --setting and --rep are all required",
    );
  if (!existsSync(resultsFile)) throw Error(`Missing ${resultsFile}`);
  if (!existsSync(generateFile)) throw Error(`Missing ${generateFile}`);
  const { setting } = parseLadderSetting(settingText);
  const rep = Number(repText);
  if (!Number.isInteger(rep) || rep < 0)
    throw Error(`--rep must be an integer`);
  writeDownstreamCases(out, resultsFile, {
    rows: readJsonlRows(resultsFile),
    generateCases: JSON.parse(
      readFileSync(resolve(generateFile), "utf8"),
    ) as GenerateCase[],
    setting,
    rep,
  }).then(
    (book) =>
      console.log(
        `Wrote ${book.tutor.length} tutor and ${book.assess.length} assess cases to ${resolve(out)}; skipped ${book.skipped.length} generate cases with no valid row at ${setting} rep ${rep}.`,
      ),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
