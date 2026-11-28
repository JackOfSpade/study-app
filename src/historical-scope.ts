import type { Contract, Roadmap, Track } from "./model";
import { CELL_SEPARATOR } from "./table-row";

type HistoricalScope = NonNullable<Contract["historicalScope"]>;

// Each scope is read once per progress text and source.
const scopeCache = new WeakMap<
  Roadmap["tracks"][Track],
  { progress: string; sourceHash: string; scopes: Map<string, HistoricalScope> }
>();

// Source records remain attributed prose. They are not inferred machine proofs,
// new evidence, or permission to reopen a future tier.
export function historicalScope(
  r: Roadmap,
  track: Track,
  objectiveId: string,
  depth: number,
): HistoricalScope {
  const t = r.tracks[track];
  let cached = scopeCache.get(t);
  if (cached?.progress !== t.progress || cached.sourceHash !== r.sourceHash) {
    cached = {
      progress: t.progress,
      sourceHash: r.sourceHash,
      scopes: new Map(),
    };
    scopeCache.set(t, cached);
  }
  const key = `${objectiveId}|${depth}`;
  let scope = cached.scopes.get(key);
  if (!scope)
    cached.scopes.set(
      key,
      (scope = readHistoricalScope(r, track, objectiveId, depth)),
    );
  // A fresh copy each time: contracts store this value in the saved record.
  return {
    sourceHash: scope.sourceHash,
    gaps: scope.gaps.map((g) => ({ ...g })),
    evidenceRows: [...scope.evidenceRows],
  };
}

function readHistoricalScope(
  r: Roadmap,
  track: Track,
  objectiveId: string,
  depth: number,
): HistoricalScope {
  const progress = r.tracks[track].progress;
  // Lenient on purpose: a saved document may head its 0.6 section differently.
  const gapSection = progress.split("### 0.6 ")[1]?.split("### 0.7 ")[0] ?? "";
  const gaps = gapSection.split("\n").flatMap((line) => {
    if (!/^\| G\d+ \|/.test(line)) return [];
    const c = line.split(CELL_SEPARATOR).map((s) => s.trim());
    const scope = /^([TX]\d{2}\.\d+) \/ D([1-4])$/.exec(c[2]);
    if (!scope || `${track}:${scope[1]}` !== objectiveId || +scope[2] !== depth)
      return [];
    return [
      {
        id: c[1],
        objectiveId,
        depth,
        kind: c[3],
        preserved: c[4],
        missing: c[5],
        evidenceRefs: c[6],
        status: c[7],
        nextCheck: c[8],
        revisit: c[9],
      },
    ];
  });
  const shortId = objectiveId.slice(track.length + 1);
  const evidenceSection =
    progress
      .split("### 0.5 Assessment evidence register")[1]
      ?.split("### 0.5.1 ")[0] ?? "";
  const depthToken = new RegExp(`\\bD${depth}\\b`);
  const evidenceRows = evidenceSection.split("\n").filter((line) => {
    if (!/^\| S\d{4}-EV\d+ \|/.test(line)) return false;
    const c = line.split(CELL_SEPARATOR).map((s) => s.trim());
    // Exact objective tokens prevent T01.1 matching T01.10 or PE/PY collisions.
    // A truncated row has no objective cell; it matches nothing.
    const ids: string[] = c[4]?.match(/[TX]\d{2}\.\d+(?!\d)/g) ?? [];
    return ids.includes(shortId) && depthToken.test(c[5]);
  });
  return { sourceHash: r.sourceHash, gaps, evidenceRows };
}
