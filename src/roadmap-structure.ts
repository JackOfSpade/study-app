import type { RoadmapAdoptionReceipt } from "./roadmap-adoption-types";
import { tableCells } from "./table-row";
const names = [
  "SHARED_PROGRESS",
  "MERGE_RULES",
  "PY_PROGRESS",
  "PY_CURRICULUM",
  "PE_PROGRESS",
  "PE_CURRICULUM",
];
/** Blocks every saved document must carry byte-for-byte from the source. */
export const PROTECTED_BLOCKS = [
  "MERGE_RULES",
  "PY_CURRICULUM",
  "PE_CURRICULUM",
] as const;
/** The text between a block's `<!-- BEGIN name -->` and `<!-- END name -->`
 * markers, from the first BEGIN to the next END, or undefined when either is
 * missing. The newline after the BEGIN marker stays in the text. */
export const blockText = (raw: string, name: string) =>
  raw.split(`<!-- BEGIN ${name} -->`)[1]?.split(`<!-- END ${name} -->`)[0];
/** The body of the first `### heading` section: the text after its heading
 * line, up to the next `### ` heading. Undefined when the heading is missing. */
export function sectionBody(raw: string, heading: string) {
  const marker = `### ${heading}\n`,
    a = raw.indexOf(marker);
  return a < 0 ? undefined : raw.slice(a + marker.length).split("\n### ")[0];
}
/** The first `### heading` section including its heading line, as offsets and
 * text, up to the next `### ` heading. Undefined when the heading is missing. */
export function sectionRange(raw: string, heading: string) {
  const start = raw.indexOf(`### ${heading}\n`);
  if (start < 0) return undefined;
  const found = raw.indexOf("\n### ", start + 4),
    end = found < 0 ? raw.length : found;
  return { start, end, text: raw.slice(start, end) };
}
/** The raw `| G… |` rows of a track progress block's 0.6 gap section, or
 * undefined when the section is missing. */
export const gapRows = (progress: string) =>
  sectionBody(progress, "0.6 Facet gaps, unknowns, and dependencies")
    ?.split("\n")
    .filter((line) => /^\| G\d+ \|/.test(line));
/** True for a progress-row key in a 0.5 evidence or 0.5.1 attempt register. */
export const isAssessmentRegisterKey = (key: string) =>
  /\/0\.5(?:\.1)? /.test(key);
export function sourceSessionStatus(value: string) {
  return value.includes("INTERRUPTED_AT_LAST_SAVE")
    ? ("INTERRUPTED_AT_LAST_SAVE" as const)
    : /\bOPEN\b/i.test(value)
      ? ("open" as const)
      : /\bCLOSED\b/i.test(value)
        ? ("closed" as const)
        : ("imported" as const);
}
export function inspectMergedDocument(raw: string) {
  if (!raw.startsWith("---\n"))
    throw Error("Missing LF-delimited merged front matter");
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) throw Error("Unterminated merged front matter");
  const header = raw.slice(4, end);
  const field = (key: string) => {
    const found = [...header.matchAll(new RegExp(`^${key}: (.+)$`, "gm"))];
    if (found.length !== 1) throw Error(`Missing or repeated header ${key}`);
    return found[0][1].replace(/^"(.*)"$/, "$1");
  };
  if (
    field("document_id") !== "interview_prep_roadmap" ||
    field("merge_schema_version") !== "1.0"
  )
    throw Error("Unsupported document identity or schema");
  const integer = (key: string) => {
    const value = field(key);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw Error(`Invalid ${key}`);
    return Number(value);
  };
  const blocks: Record<string, string> = {};
  let lastEnd = end;
  for (const name of names) {
    const start = `<!-- BEGIN ${name} -->\n`,
      stop = `<!-- END ${name} -->`;
    if (raw.split(start).length !== 2 || raw.split(stop).length !== 2)
      throw Error(`Missing or repeated ${name} marker`);
    const a = raw.indexOf(start),
      b = raw.indexOf(stop);
    if (a < lastEnd || b <= a) throw Error(`Reordered or nested ${name} block`);
    blocks[name] = raw.slice(a + start.length, b);
    lastEnd = b + stop.length;
  }
  const markers = [...raw.matchAll(/<!-- (?:BEGIN|END) ([A-Z_]+) -->/g)].map(
    (m) => m[1],
  );
  if (
    markers.length !== names.length * 2 ||
    markers.some((n) => !names.includes(n))
  )
    throw Error("Unexpected or malformed progress markers");
  const rows = new Map<string, string>();
  for (const name of names.filter((n) => n.endsWith("PROGRESS"))) {
    let heading = "",
      table = 0,
      inTable = false;
    let headers: string[] = [];
    for (const line of blocks[name].split("\n")) {
      if (/^### /.test(line)) {
        heading = line.slice(4);
        table = 0;
      }
      if (!line.startsWith("|")) {
        inTable = false;
        continue;
      }
      const isHeader = !inTable;
      if (!inTable) {
        table++;
        inTable = true;
      }
      const cells = tableCells(line);
      if (!cells.length || cells.every((c) => /^:?-+:?$/.test(c))) continue;
      if (isHeader) headers = cells;
      const identity =
        headers[0] === "Counter" && headers[1] === "Scope"
          ? `${cells[0]}/${cells[1]}`
          : headers[0] === "Scope" && headers[1] === "Facet"
            ? [
                cells[0],
                cells[1],
                ...(headers.includes("Assessment receipt")
                  ? [cells[headers.indexOf("Assessment receipt")]]
                  : []),
              ].join("/")
            : cells[0];
      const key = `${name}/${heading}/${table}/${identity}`;
      if (rows.has(key)) throw Error(`Duplicate progress row ${key}`);
      rows.set(key, line);
    }
  }
  return {
    field,
    revision: integer("revision"),
    previous: integer("previous_revision"),
    blocks,
    rows,
  };
}
const receiptRowCache = new WeakMap<
  RoadmapAdoptionReceipt,
  { text: string; rows: ReturnType<typeof inspectMergedDocument>["rows"] }
>();
/** Cached merged-document rows for an adoption receipt, keyed on canonical text. */
export function receiptRows(receipt: RoadmapAdoptionReceipt) {
  const text = receipt.proposal.canonical,
    old = receiptRowCache.get(receipt);
  if (old?.text === text) return old.rows;
  const rows = inspectMergedDocument(text).rows;
  receiptRowCache.set(receipt, { text, rows });
  return rows;
}
