import { historicalScope } from "./historical-scope";
import { importedProofValid } from "./imported-proof";
import {
  facetMappingShapeValid,
  trackOf,
  type FacetProof,
  type HistoricalFacetMapping,
  type LearnerLedger,
} from "./learning-model";
import type { Roadmap } from "./model";
import { observationInvalidated } from "./observation-validity";
import { CELL_SEPARATOR } from "./table-row";

export function historicalRecords(
  r: Roadmap,
  objectiveId: string,
  depth: number,
) {
  return historicalScope(
    r,
    trackOf(objectiveId),
    objectiveId,
    depth,
  ).evidenceRows.map((row) => {
    const c = row.split(CELL_SEPARATOR).map((s) => s.trim());
    return {
      id: c[1],
      date: c[3],
      mode: c[6],
      assistance: c[7],
      score: c[8],
      observation: c[9],
    };
  });
}

/** Structural source checks complement the trusted assessor's semantic mapping.
 * Matching topic numbers or a high score alone never establishes equivalence. */
export function validateHistoricalMapping(
  r: Roadmap,
  l: LearnerLedger,
  m: HistoricalFacetMapping,
) {
  const def = l.scopes[m.scopeId];
  const objective = r.tracks[trackOf(def?.objectiveId ?? "")].objectives.find(
    (o) => o.id === def?.objectiveId,
  );
  if (
    !def ||
    !objective ||
    def.id !== `${objective.id}/D${def.depth}` ||
    !Number.isInteger(def.depth) ||
    def.depth < 1 ||
    def.depth > objective.target ||
    def.sourceScope !== objective.scope ||
    m.sourceHash !== r.sourceHash ||
    l.sourceHash !== r.sourceHash ||
    !facetMappingShapeValid(def, m)
  )
    throw Error("Invalid historical facet mapping");
  if (
    m.sourceExcerpts &&
    (Object.keys(m.sourceExcerpts).length > 20 ||
      Object.entries(m.sourceExcerpts).some(
        ([id, text]) =>
          !m.evidenceIds.includes(id) ||
          typeof text !== "string" ||
          text.length > 3000,
      ))
  )
    throw Error("Invalid source excerpt references");
  const records = historicalRecords(r, objective.id, def.depth);
  for (const ref of m.evidenceIds) {
    const record = records.find((row) => row.id === ref);
    if (!record)
      throw Error(
        "Historical evidence does not match this track, objective and depth",
      );
    if (m.outcome === "unknown") continue;
    if (
      !["DIAGNOSTIC", "GUIDED"].includes(record.mode) ||
      !/^[0-3]$/.test(record.score)
    )
      throw Error(
        "Unscored or reported exposure cannot become observed facet proof",
      );
    if (m.outcome === "independent") {
      const unassisted =
        ["NONE", "NEUTRAL_CLARIFICATION"].includes(record.assistance) &&
        Number(record.score) >= 2 &&
        record.mode === "DIAGNOSTIC";
      const excerpt = m.sourceExcerpts?.[ref];
      const mixedIndependent =
        record.assistance === "MIXED" &&
        typeof excerpt === "string" &&
        excerpt.length >= 24 &&
        record.observation.includes(excerpt) &&
        /\bindependently\b/i.test(excerpt);
      if (!unassisted && !mixedIndependent)
        throw Error(
          "Historical assistance cannot certify independent scope; mixed rows need an exact independent excerpt and semantic review",
        );
    }
    if (m.outcome === "contradicted" && Number(record.score) >= 2)
      throw Error(
        "A successful source observation cannot be relabeled as a historical failure",
      );
  }
  return { def };
}

export function historicalProofValid(
  r: Roadmap,
  l: LearnerLedger,
  objectiveId: string,
  depth: number,
  facet: string,
  ref: string,
  outcome: FacetProof["outcome"] = "independent",
) {
  const scopeId = `${objectiveId}/D${depth}`;
  const review = l.historicalReviews
    ?.filter((m) => m.scopeId === scopeId && m.facet === facet)
    .at(-1);
  if (
    !review ||
    review.outcome !== outcome ||
    !review.evidenceIds.includes(ref)
  )
    return false;
  try {
    validateHistoricalMapping(r, l, review);
    return historicalReviewAuthorized(l, review);
  } catch {
    return false;
  }
}

export function historicalReviewAuthorized(
  l: LearnerLedger,
  review: HistoricalFacetMapping & { assessmentId: string },
) {
  try {
    const receipt = l.receipts[review.assessmentId];
    const mappings =
      receipt &&
      (JSON.parse(receipt.signature).historicalMappings as
        HistoricalFacetMapping[] | undefined);
    return !!mappings?.some(
      (m) => historicalMappingKey(m) === historicalMappingKey(review),
    );
  } catch {
    return false;
  }
}

function historicalMappingKey(m: HistoricalFacetMapping) {
  return JSON.stringify([
    m.scopeId,
    m.facet,
    m.sourceHash,
    m.evidenceIds,
    m.outcome,
    m.rationale,
    Object.entries(m.sourceExcerpts ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  ]);
}

export function facetProofValid(
  r: Roadmap,
  l: LearnerLedger,
  objectiveId: string,
  depth: number,
  facet: string,
  ref: string,
  outcome: FacetProof["outcome"],
) {
  if (outcome === "unknown" || observationInvalidated(r, l, objectiveId, ref))
    return false;
  return (
    l.evidence.some(
      (e) =>
        e.id === ref &&
        e.objectiveId === objectiveId &&
        e.depth === depth &&
        e.facet === facet &&
        e.outcome === outcome,
    ) ||
    importedProofValid(r, l, objectiveId, depth, facet, ref, outcome) ||
    historicalProofValid(r, l, objectiveId, depth, facet, ref, outcome)
  );
}

export function independentProofValid(
  r: Roadmap,
  l: LearnerLedger,
  objectiveId: string,
  depth: number,
  facet: string,
  ref: string,
) {
  return facetProofValid(r, l, objectiveId, depth, facet, ref, "independent");
}

/** Whether every listed facet of objectiveId at depth has an independent
 * outcome backed by a currently valid independent proof. An empty list is
 * vacuously proven; callers that need a facet check the length themselves. */
export function facetsIndependentlyProven(
  r: Roadmap,
  l: LearnerLedger,
  objectiveId: string,
  depth: number,
  scopeFacets: readonly { id: string }[],
  facets: Record<string, FacetProof>,
) {
  return scopeFacets.every((f) => {
    const proof = facets[`D${depth}:${f.id}`];
    return (
      proof?.outcome === "independent" &&
      proof.evidenceIds.some((ref) =>
        independentProofValid(r, l, objectiveId, depth, f.id, ref),
      )
    );
  });
}

/** Whether a verified scope has at least one facet and every facet is backed
 * by a currently valid independent proof. Callers check the scope's identity
 * (objective, depth, source scope) against what they expect. */
export function scopeIndependentlyProven(
  r: Roadmap,
  l: LearnerLedger,
  scopeId: string,
  facets: Record<string, FacetProof>,
) {
  const def = l.scopes[scopeId];
  return (
    !!def &&
    def.facets.length > 0 &&
    l.verifiedScopes.includes(scopeId) &&
    facetsIndependentlyProven(
      r,
      l,
      def.objectiveId,
      def.depth,
      def.facets,
      facets,
    )
  );
}
