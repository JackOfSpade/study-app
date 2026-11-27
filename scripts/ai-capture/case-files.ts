/**
 * What the case builders share: their CLI flags, reading a ladder's
 * results.jsonl, picking an arm's answer, and writing case files privately
 * beside a shared index.json of operation -> case count.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error Local .mjs module without a declaration shim (as the tests import it).
import { parseSetting as ladderParseSetting } from "../ai-ladder.mjs";

/** The ladder's own `<model>:<effort>` grammar (it refuses `max`), typed. */
export const parseLadderSetting = ladderParseSetting as (value: string) => {
  model: string;
  effort: string;
  setting: string;
};

/** The fields of a ladder results.jsonl row that the builders read. */
export type LadderRow = {
  caseId: string;
  operation: string;
  setting: string;
  rep: number;
  outcome: string;
  answers?: unknown[];
};

/** The topic of an objective id: `PY:T05.2` -> `T05`. */
export const topicOf = (id: string | undefined) =>
  id?.split(":")[1]?.split(".")[0] ?? "";

/** The value after `name` on the command line, or the fallback when absent. */
export function argument(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

/** Every row of a results.jsonl file; a malformed line fails with its number. */
export function readJsonlRows(file: string): LadderRow[] {
  const rows: LadderRow[] = [];
  for (const [index, line] of readFileSync(resolve(file), "utf8")
    .split("\n")
    .entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LadderRow);
    } catch {
      throw Error(`${file}:${index + 1} is not valid JSONL`);
    }
  }
  return rows;
}

/** The last answer of the first valid row at exactly this case, operation,
 * setting and rep, or undefined when that arm has none. */
export function lastValidAnswer(
  rows: readonly LadderRow[],
  {
    caseId,
    operation,
    setting,
    rep,
  }: Pick<LadderRow, "caseId" | "operation" | "setting" | "rep">,
): unknown {
  const row = rows.find(
    (candidate) =>
      candidate.caseId === caseId &&
      candidate.operation === operation &&
      candidate.setting === setting &&
      candidate.rep === rep &&
      candidate.outcome === "valid" &&
      Array.isArray(candidate.answers) &&
      candidate.answers.length > 0,
  );
  return row?.answers?.at(-1);
}

function writePrivateJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readIndex(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch (error) {
    throw Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!index || typeof index !== "object" || Array.isArray(index))
    throw Error("index.json must hold an operation -> count object");
  return index as Record<string, unknown>;
}

/**
 * Write each case file (0600) into a private (0700) directory. With `counts`,
 * also merge them into its index.json, keeping other builders' counts; a
 * corrupt index then fails before anything is written.
 */
export function writeCaseFiles(
  out: string,
  files: Record<string, unknown>,
  counts?: Record<string, number>,
) {
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const indexFile = join(target, "index.json");
  const index = counts ? readIndex(indexFile) : undefined;
  for (const [name, cases] of Object.entries(files))
    writePrivateJson(join(target, name), cases);
  if (index) writePrivateJson(indexFile, Object.assign(index, counts));
  return { target, index };
}
