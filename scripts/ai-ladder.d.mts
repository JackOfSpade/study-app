export interface LadderSetting {
  model: string;
  effort: string;
  /** `model:effort`. */
  setting: string;
}
export interface LadderCase {
  id: string;
  operation: string;
  payload: Record<string, unknown>;
}
export interface LadderResultRow {
  v: 1;
  at: string;
  runId: string;
  caseId: string;
  operation: string;
  setting: string;
  rep: number;
  outcome: string;
  answers: unknown[];
  attempts: number;
  corrections: number;
  costUsd: number | null;
  durationMs: number | null;
  firstTextMs: number | null;
  model: string[];
}
export interface LadderSummaryEntry {
  operation: string;
  setting: string;
  n: number;
  validRate: number;
  firstTryRate: number;
  meanCostUsd: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p95FirstTextMs: number | null;
}
/** `model:effort`, refusing anything production never offers (e.g. `max`). */
export function parseSetting(value: unknown): LadderSetting;
export function parseSettings(settings: unknown): LadderSetting[];
export function defaultOut(name: unknown): string;
/** Why a directory is a bad place to keep a run, or null when it is fine. */
export function unsafeOutReason(out: string): string | null;
export function assertSafeOut(
  out: unknown,
  options?: { ephemeral?: boolean },
): void;
export function readCaseFile(file: string): LadderCase[];
/** A replay-sample directory: one case per live call, in file-name order. */
export function readReplayCases(directory: string): LadderCase[];
export function readCases(target: unknown): LadderCase[];
export function readLadderRows(out: string): Record<string, unknown>[];
/** Runs every case under every setting, one fresh gateway per arm. */
export function runLadder(options?: {
  cases?: LadderCase[];
  settings?: unknown;
  reps?: number;
  out?: string;
  parallel?: number;
  gatewayFactory?: (options: {
    profileFor: (
      operation: string,
      payload: unknown,
    ) => Record<string, unknown>;
    usageLog: (row: Record<string, unknown>) => void;
  }) => { run(operation: string, payload: unknown): Promise<unknown> };
  only?: unknown;
  ephemeral?: boolean;
  name?: string;
  runId?: string;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<{
  runId: string;
  out: string;
  resultsFile: string;
  rows: LadderResultRow[];
}>;
/** Nearest-rank percentile over the measured values, or null when none. */
export function percentile(values: unknown[], p: number): number | null;
/** Per operation × setting: reliability, retry-inclusive cost and speed. */
export function summarizeLadder(rows: unknown): LadderSummaryEntry[];
/** The settings per operation, cheapest mean cost first (unknown cost last). */
export function cheapestFirst(
  summary: unknown,
): { operation: string; settings: string[] }[];
export function formatSummary(summary: LadderSummaryEntry[]): string;
export function parseArgs(argv: string[]): {
  _: string[];
  [flag: string]: unknown;
};
