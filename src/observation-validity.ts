import { trackOf, type LearnerLedger } from "./learning-model";
import type { Roadmap } from "./model";
import { inspectMergedDocument } from "./roadmap-structure";
import { tableCells } from "./table-row";

/** The latest adopted roadmap document, when one replaced the bundled source. */
export const adoptedSourceText = (l?: LearnerLedger) =>
  l?.roadmapAdoptions?.at(-1)?.proposal.canonical;

const cache = new WeakMap<
  LearnerLedger,
  { text: string; invalid: Set<string>; attempts: Map<string, string> }
>();

/** Later retained source dispositions qualify earlier receipts. Keeping an
 * observation is not permission to keep counting it after its task is invalid. */
export function observationInvalidated(
  r: Roadmap,
  l: LearnerLedger,
  objective: string,
  ref: string,
) {
  const text = adoptedSourceText(l) ?? r.raw;
  let read = cache.get(l);
  if (read?.text !== text) {
    const invalid = new Set<string>(),
      attempts = new Map<string, string>();
    for (const [key, row] of inspectMergedDocument(text).rows) {
      const c = tableCells(row),
        track = key.split("_")[0];
      if (
        key.includes("/0.5.1 Attempt status register/") &&
        /^INVALIDATED\b/.test(c[3] ?? "")
      )
        invalid.add(`${track}:${c[0]}`);
      if (key.includes("/0.5 Assessment evidence register/"))
        attempts.set(`${track}:${c[0]}`, c[1]);
    }
    read = { text, invalid, attempts };
    cache.set(l, read);
  }
  const track = objective.split(":")[0];
  const actual = l.evidence.find(
    (e) => e.id === ref && e.objectiveId === objective,
  );
  const attempt = actual?.attemptId ?? read.attempts.get(`${track}:${ref}`);
  return !!attempt && read.invalid.has(`${track}:${attempt}`);
}

/** The source objective, only when its cell at this depth is a pass. */
function checkpointObjective(r: Roadmap, objective: string, depth: number) {
  const o = r.tracks[trackOf(objective)].objectives.find(
    (o) => o.id === objective,
  );
  return o?.cells[depth - 1] === "P" ? o : undefined;
}

/** Only the explicit checkpoint support clause carries the trusted baseline
 * exemption. Contextual/earlier evidence is retained separately. */
export function baselineCheckpointRefs(
  r: Roadmap,
  objective: string,
  depth: number,
): string[] {
  const o = checkpointObjective(r, objective, depth);
  if (!o) return [];
  const clause = new RegExp(`(?:^|;)\\s*D${depth}=([^;]+)`).exec(o.refs)?.[1];
  return [...new Set(clause?.match(/\bS\d{4}-EV\d{2,}\b/g) ?? [])];
}

export function baselineCheckpointValid(
  r: Roadmap,
  l: LearnerLedger,
  objective: string,
  depth: number,
) {
  return (
    !!checkpointObjective(r, objective, depth) &&
    !baselineCheckpointRefs(r, objective, depth).some((ref) =>
      observationInvalidated(r, l, objective, ref),
    )
  );
}

/** Keep the old retention fact, while scheduling repair of withdrawn support. */
export function baselineReviewSuspended(
  r: Roadmap,
  l: LearnerLedger,
  review: { objectiveId: string; depth: number },
) {
  // Refs exist only for a passed source cell, so the checkpoint is valid
  // exactly when none of them has been invalidated.
  const refs = baselineCheckpointRefs(r, review.objectiveId, review.depth);
  return (
    refs.length > 0 &&
    refs.some((ref) => observationInvalidated(r, l, review.objectiveId, ref)) &&
    l.cells[review.objectiveId]?.states[review.depth - 1] !== "P"
  );
}
