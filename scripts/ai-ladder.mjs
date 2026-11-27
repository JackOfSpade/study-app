#!/usr/bin/env node
/** Replays captured AI calls through every model/effort arm, so a setting
 * choice is measured instead of guessed. Nothing here changes production
 * behaviour: a ladder always builds its own gateways. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClaudeGateway, taskProfile } from "./claude-gateway.mjs";
import { isNumber, mean, percentile, sumKnown } from "./lib/measure.mjs";
import { privateDirectory } from "./lib/private-fs.mjs";

export { percentile };

const MODELS = ["haiku", "sonnet", "opus"];
const EFFORTS = ["low", "medium", "high", "xhigh"];

/** One arm's identity: case, setting and rep. A judgment shares its row's key. */
export const rowKey = ({ caseId, setting, rep }) =>
  `${caseId}\u0000${setting}\u0000${rep}`;

/** Outcomes that say the host could not run the arm (out of usage, signed
 * out, no CLI), not that the setting answered badly. Such a row stays in
 * results.jsonl but never counts as finished: a resumed run retries it. */
export const HOST_FAILURES = new Set([
  "usage-limit",
  "not-signed-in",
  "cli-missing",
]);

const HOST_FAILURE_LABELS = {
  "usage-limit": "Usage limit reached",
  "not-signed-in": "The Claude CLI is not signed in",
  "cli-missing": "The Claude CLI was not found",
};

/** The newest row per arm with host failures left out, so a retried arm
 * supersedes its failed row and a host problem never scores the setting. */
export function latestRows(rows) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || HOST_FAILURES.has(row.outcome)) continue;
    const key = rowKey(row);
    latest.delete(key);
    latest.set(key, row);
  }
  return [...latest.values()];
}

/** A comma list (or an array) as trimmed, non-empty entries. */
export function parseList(value) {
  const list = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : String(value).split(",");
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

/** `model:effort`, refusing anything production never offers (e.g. `max`). */
export function parseSetting(value) {
  const text = String(value ?? "").trim();
  const match = /^([a-z0-9]+):([a-z0-9]+)$/.exec(text);
  if (!match)
    throw Error(
      `Invalid setting "${text}": expected <haiku|sonnet|opus>:<low|medium|high|xhigh>`,
    );
  const [, model, effort] = match;
  if (!MODELS.includes(model))
    throw Error(
      `Invalid setting "${text}": model must be haiku, sonnet or opus (got "${model}")`,
    );
  if (!EFFORTS.includes(effort))
    throw Error(
      `Invalid setting "${text}": effort must be low, medium, high or xhigh (got "${effort}")`,
    );
  return { model, effort, setting: `${model}:${effort}` };
}

export function parseSettings(settings) {
  const list = Array.isArray(settings)
    ? settings
    : typeof settings === "string"
      ? settings.split(",").map((entry) => entry.trim())
      : [];
  const wanted = list.filter(Boolean);
  if (!wanted.length)
    throw Error("At least one setting is required, e.g. haiku:low");
  return wanted.map(parseSetting);
}

export function defaultOut(name) {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "study-app",
    "ai-test-runs",
    String(name),
  );
}

const unsafeRoots = () => [
  ...new Set(
    [
      tmpdir(),
      "/tmp",
      "/private/tmp",
      "/private/var/folders",
      "/var/folders",
    ].map((root) => resolve(root)),
  ),
];

/** Why a directory is a bad place to keep a run, or null when it is fine. */
export function unsafeOutReason(out) {
  const target = resolve(out);
  for (const root of unsafeRoots())
    if (target === root || target.startsWith(`${root}/`))
      return `it is under the temporary directory ${root}`;
  if (`${target}/`.includes("/scratchpad/"))
    return "it is a scratchpad directory";
  return null;
}

export function assertSafeOut(out, { ephemeral = false } = {}) {
  if (typeof out !== "string" || !out.trim())
    throw Error("An output directory is required");
  const reason = unsafeOutReason(out);
  if (reason && !ephemeral)
    throw Error(
      `Refusing output directory ${out}: ${reason}. Pass --ephemeral (or ephemeral: true) to allow it.`,
    );
}

function normalizeCase(item, fallbackId) {
  if (!item || typeof item !== "object")
    throw Error(`Case ${fallbackId} must be an object`);
  const operation = item.operation;
  if (typeof operation !== "string" || !operation)
    throw Error(`Case ${fallbackId} needs an operation`);
  const id = typeof item.id === "string" && item.id ? item.id : fallbackId;
  if (!item.payload || typeof item.payload !== "object")
    throw Error(`Case ${id} needs a payload object`);
  return { id, operation, payload: item.payload };
}

export function readCaseFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Error(`Invalid cases file ${file}: ${error.message}`);
  }
  if (!Array.isArray(parsed))
    throw Error(`Cases file ${file} must hold a JSON array`);
  return parsed.map((item, index) =>
    normalizeCase(item, `${file}#${index + 1}`),
  );
}

/** A replay-sample directory: one case per live call, in file-name order. */
export function readReplayCases(directory) {
  const cases = [];
  for (const operation of readdirSync(directory).sort()) {
    const folder = join(directory, operation);
    if (!statSync(folder).isDirectory()) continue;
    for (const name of readdirSync(folder)
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      let sample;
      try {
        sample = JSON.parse(readFileSync(join(folder, name), "utf8"));
      } catch {
        continue;
      }
      const payload = sample?.payload;
      if (!payload || typeof payload !== "object") continue;
      cases.push({ id: name.replace(/\.json$/, ""), operation, payload });
    }
  }
  return cases;
}

export function readCases(target) {
  if (typeof target !== "string" || !target)
    throw Error("Pass --cases <file|dir>");
  if (!existsSync(target)) throw Error(`Cases not found: ${target}`);
  if (statSync(target).isDirectory()) return readReplayCases(target);
  return readCaseFile(target);
}

export function readLadderRows(out) {
  const file = join(out, "results.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const outcomeOf = (error) => {
  if (error?.code === "CLAUDE_INVALID_ANSWER") return "invalid";
  return (
    String(error?.code ?? "")
      .replace(/^CLAUDE_/, "")
      .toLowerCase()
      .replace(/_/g, "-") || "error"
  );
};

/** Runs every case under every setting, one fresh gateway per arm, appending
 * each row at once so an interrupted run resumes where it stopped. */
export async function runLadder({
  cases,
  settings,
  reps = 1,
  out,
  parallel = 2,
  gatewayFactory = createClaudeGateway,
  only,
  ephemeral = false,
  name,
  runId,
  now = Date.now,
  log = console.log,
} = {}) {
  // Settings are validated before any directory or gateway is touched.
  const chosen = parseSettings(settings);
  assertSafeOut(out, { ephemeral });
  if (!Array.isArray(cases)) throw Error("cases must be an array");
  if (!Number.isInteger(reps) || reps < 1)
    throw Error("reps must be a positive integer");
  const limit = Math.max(1, Math.floor(Number(parallel)) || 1);
  privateDirectory(out);
  const resultsFile = join(out, "results.jsonl");
  const done = new Set(
    readLadderRows(out)
      .filter((row) => !HOST_FAILURES.has(row.outcome))
      .map(rowKey),
  );
  const wanted = new Set(parseList(only));
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const ladderId = runId ?? `${name ?? "ladder"}-${stamp}`;
  const jobs = [];
  for (const entry of cases) {
    if (wanted.size && !wanted.has(entry.operation)) continue;
    for (const setting of chosen)
      for (let rep = 0; rep < reps; rep++) jobs.push({ entry, setting, rep });
  }
  const rows = [];
  let next = 0,
    stopped = false;
  const runArm = async ({ entry, setting, rep }) => {
    const usageRows = [];
    const gateway = gatewayFactory({
      profileFor: (operation, payload) => ({
        ...taskProfile(operation, payload),
        model: setting.model,
        effort: setting.effort,
      }),
      usageLog: (row) => usageRows.push(row),
    });
    const answers = [];
    let outcome = "valid";
    try {
      answers.push(await gateway.run(entry.operation, entry.payload));
    } catch (error) {
      outcome = outcomeOf(error);
    }
    return {
      v: 1,
      at: new Date(now()).toISOString(),
      runId: ladderId,
      caseId: entry.id,
      operation: entry.operation,
      setting: setting.setting,
      rep,
      outcome,
      answers,
      attempts: usageRows.length,
      corrections: usageRows.filter((row) => row.attempt === 1).length,
      costUsd: sumKnown(usageRows.map((row) => row.costUsd)),
      durationMs: sumKnown(usageRows.map((row) => row.durationMs)),
      firstTextMs:
        usageRows.map((row) => row.firstTextMs).find(isNumber) ?? null,
      model: [
        ...new Set(
          usageRows
            .map((row) => row.model)
            .filter((model) => typeof model === "string" && model),
        ),
      ],
    };
  };
  const worker = async () => {
    while (!stopped) {
      const job = jobs[next++];
      if (!job) return;
      if (
        done.has(
          rowKey({
            caseId: job.entry.id,
            setting: job.setting.setting,
            rep: job.rep,
          }),
        )
      )
        continue;
      const row = await runArm(job);
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      rows.push(row);
      if (HOST_FAILURES.has(row.outcome)) {
        // An arm another worker had in flight may fail the same way; only the
        // first stop is reported.
        if (!stopped)
          log(
            `${HOST_FAILURE_LABELS[row.outcome]} on ${row.caseId} (${row.setting}); stopping. New rows: ${rows.length}. Resume later with the same --out.`,
          );
        stopped = true;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
  );
  return { runId: ladderId, out, resultsFile, rows };
}

/** Per operation × setting: reliability, retry-inclusive cost and speed over
 * the newest row per arm (host failures left out). */
export function summarizeLadder(rows) {
  const groups = new Map();
  for (const row of latestRows(rows)) {
    const key = `${row.operation}\u0000${row.setting}`;
    const group = groups.get(key) ?? {
      operation: row.operation,
      setting: row.setting,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const summary = [];
  for (const { operation, setting, rows: group } of groups.values()) {
    const n = group.length;
    const costs = group.map((row) => row.costUsd);
    const durations = group.map((row) => row.durationMs);
    const firsts = group.map((row) => row.firstTextMs);
    summary.push({
      operation,
      setting,
      n,
      validRate: group.filter((row) => row.outcome === "valid").length / n,
      firstTryRate:
        group.filter((row) => row.outcome === "valid" && row.corrections === 0)
          .length / n,
      meanCostUsd: mean(costs),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      p95FirstTextMs: percentile(firsts, 95),
    });
  }
  return summary.sort(
    (a, b) =>
      a.operation.localeCompare(b.operation) ||
      a.setting.localeCompare(b.setting),
  );
}

/** The settings per operation, cheapest mean cost first (unknown cost last). */
export function cheapestFirst(summary) {
  const grouped = new Map();
  for (const entry of Array.isArray(summary) ? summary : []) {
    const list = grouped.get(entry.operation) ?? [];
    list.push(entry);
    grouped.set(entry.operation, list);
  }
  return [...grouped.keys()].sort().map((operation) => ({
    operation,
    settings: grouped
      .get(operation)
      .sort((a, b) => {
        const left = isNumber(a.meanCostUsd) ? a.meanCostUsd : Infinity;
        const right = isNumber(b.meanCostUsd) ? b.meanCostUsd : Infinity;
        return left === right
          ? a.setting.localeCompare(b.setting)
          : left - right;
      })
      .map((entry) => entry.setting),
  }));
}

const percent = (value) =>
  isNumber(value) ? `${Math.round(value * 100)}%` : "-";
const money = (value) => (isNumber(value) ? value.toFixed(4) : "-");
const number = (value) => (isNumber(value) ? String(value) : "-");

export function formatSummary(summary) {
  const headers = [
    "operation",
    "setting",
    "n",
    "valid",
    "first-try",
    "mean$",
    "p50ms",
    "p95ms",
    "p95first",
  ];
  const table = summary.map((entry) => [
    entry.operation,
    entry.setting,
    String(entry.n),
    percent(entry.validRate),
    percent(entry.firstTryRate),
    money(entry.meanCostUsd),
    number(entry.p50DurationMs),
    number(entry.p95DurationMs),
    number(entry.p95FirstTextMs),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...table.map((row) => row[column].length)),
  );
  const line = (values) =>
    values.map((value, column) => value.padEnd(widths[column])).join("  ");
  return [line(headers), ...table.map(line)].join("\n");
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    // Only the first "=" ends the flag name, so a value may contain "=".
    const body = token.slice(2);
    const at = body.indexOf("=");
    const flag = at === -1 ? body : body.slice(0, at);
    const inline = at === -1 ? undefined : body.slice(at + 1);
    if (["json", "ephemeral"].includes(flag)) {
      args[flag] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw Error(`Missing value for --${flag}`);
    args[flag] = value;
  }
  return args;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "run") {
    if (!args.name && !args.out)
      throw Error("Pass --name <name> or --out <dir>");
    const out = args.out ?? defaultOut(args.name);
    const cases = readCases(args.cases);
    const result = await runLadder({
      cases,
      settings: args.settings,
      out,
      name: args.name,
      reps: args.reps === undefined ? 1 : Number(args.reps),
      parallel: args.parallel === undefined ? 2 : Number(args.parallel),
      only: args.only,
      ephemeral: !!args.ephemeral,
    });
    console.log(formatSummary(summarizeLadder(readLadderRows(result.out))));
    console.log(`\n${result.rows.length} new row(s) in ${result.resultsFile}`);
    return;
  }
  if (command === "summarize") {
    if (!args.name && !args.out)
      throw Error("Pass --name <name> or --out <dir>");
    const out = args.out ?? defaultOut(args.name);
    const summary = summarizeLadder(readLadderRows(out));
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      if (!summary.length)
        console.log(`No rows in ${join(out, "results.jsonl")}`);
      else console.log(formatSummary(summary));
      for (const { operation, settings } of cheapestFirst(summary))
        console.log(
          `\n${operation}: cheapest first -> ${settings.join(" < ")}`,
        );
    }
    return;
  }
  throw Error(
    "Usage: ai-ladder.mjs run --cases <file|dir> --settings a,b [--name name] | summarize [--name name] [--json]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
