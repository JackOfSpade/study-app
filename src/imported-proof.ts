import {
  facetMappingShapeValid,
  scopeKey,
  type FacetProof,
  type LearnerLedger,
} from "./learning-model";
import { PROVIDERS, type Roadmap, type Track } from "./model";
import {
  adoptedSourceText,
  observationInvalidated,
} from "./observation-validity";
import type {
  ImportedFacetMapping,
  RoadmapAdoptionReceipt,
} from "./roadmap-adoption-types";
import { isAssessedToken, isAssessedTokenFor } from "./roadmap-export-names";
import { receiptRows } from "./roadmap-structure";
import { tableCells } from "./table-row";

export { adoptedSourceText };

/** The trimmed cells of the first adopted row in `prefix` whose key ends in
 * `/suffixId`. */
function receiptCells(
  receipt: RoadmapAdoptionReceipt,
  prefix: string,
  suffixId: string,
) {
  for (const [key, row] of receiptRows(receipt))
    if (key.startsWith(prefix) && key.endsWith(`/${suffixId}`))
      return tableCells(row);
  return undefined;
}

/** Manual merged roadmaps may bind final evidence in the authoritative final
 * register instead of repeating a synthetic D4 label in the observation title.
 * An explicit conflicting depth is never overridden by that cross-reference. */
function finalRegisterDepth(
  receipt: RoadmapAdoptionReceipt,
  definition: LearnerLedger["scopes"][string],
  ref: string,
) {
  if (
    definition.depth !== 4 ||
    !/^(PY|PE):[TI]\d{2}$/.test(definition.objectiveId) ||
    definition.id !== `${definition.objectiveId}/T4`
  )
    return undefined;
  const [track, id] = definition.objectiveId.split(":"),
    integration = id.startsWith("I");
  const heading = integration
    ? "0.8 Integration coverage"
    : "0.7 Topic transfer and retention";
  const c = receiptCells(receipt, `${track}_PROGRESS/${heading}/`, id);
  if (
    !c ||
    (integration ? c[1] !== "ACTIVE" : !["U", "G", "P", "R"].includes(c[1]))
  )
    return undefined;
  const refs: string[] =
    c[integration ? 3 : 2].match(/\bS\d{4}-EV\d{2,}\b/g) ?? [];
  return refs.includes(ref) ? 4 : undefined;
}

export function importedMappingValid(
  r: Roadmap,
  l: LearnerLedger,
  v: RoadmapAdoptionReceipt,
  m: ImportedFacetMapping,
) {
  const d = l.scopes[m.scopeId];
  if (
    v.sourceHash !== r.sourceHash ||
    !PROVIDERS.includes(v.provenance) ||
    v.id !== v.proposal.requestId ||
    !d ||
    !facetMappingShapeValid(d, m)
  )
    throw Error("Invalid imported facet mapping");
  const track = d.objectiveId.split(":")[0],
    id = d.objectiveId.split(":")[1];
  for (const ref of m.evidenceIds) {
    if (!/^S\d{4}-EV\d{2,}$/.test(ref))
      throw Error(
        "Imported proof requires a canonical source evidence identifier",
      );
    const c = receiptCells(
      v,
      `${track}_PROGRESS/0.5 Assessment evidence register/`,
      ref,
    );
    if (!c) throw Error("Imported proof has no exact source evidence row");
    const excerpt = m.sourceExcerpts?.[ref];
    const scoped = (
        (c[3].match(/\b[TXI]\d{2}(?:\.\d+)?\b/g) ?? []) as string[]
      ).includes(id),
      explicitDepth = /\bD([1-4])\b/.exec(c[4]),
      depth = explicitDepth
        ? Number(explicitDepth[1])
        : d.depth === 4 && c[4].includes("Tier 4 final requirement")
          ? 4
          : finalRegisterDepth(v, d, ref);
    if (
      !scoped ||
      depth !== d.depth ||
      typeof excerpt !== "string" ||
      excerpt.length < 12 ||
      excerpt.length > 3000 ||
      !c[8]?.includes(excerpt)
    )
      throw Error("Imported evidence scope or exact excerpt does not match");
    if (m.outcome === "unknown") continue;
    const attempt = receiptCells(
      v,
      `${track}_PROGRESS/0.5.1 Attempt status register/`,
      c[1],
    );
    if (!attempt || /^INVALIDATED\b/.test(attempt[3]))
      throw Error(
        "Imported observation requires an issued, non-invalidated source attempt",
      );
    const assessed = isAssessedTokenFor(c[5], m.outcome);
    if (
      isAssessedToken(c[5]) &&
      (!assessed || /\/ ([^:]+):/.exec(c[4])?.[1] !== m.facet)
    )
      throw Error("Imported evidence outcome or named facet does not match");
    const numeric = /^[0-3](?:$|\s)/.test(c[7]) ? Number(c[7][0]) : undefined;
    if (
      !assessed &&
      !["DIAGNOSTIC", "INDEPENDENT", "TRANSFER", "REVIEW", "GUIDED"].includes(
        c[5],
      )
    )
      throw Error(
        "Reported or unscored exposure cannot establish imported observation",
      );
    if (numeric === undefined) throw Error("Imported observation is unscored");
    if (m.outcome === "independent") {
      const unassisted =
        ["NONE", "NEUTRAL_CLARIFICATION", "NONE FOR THIS FACET"].includes(
          c[6],
        ) &&
        numeric >= 2 &&
        c[5] !== "GUIDED";
      const mixed =
        numeric >= 2 &&
        c[5] !== "GUIDED" &&
        c[6] === "MIXED" &&
        excerpt.length >= 24 &&
        /\bindependently\b/i.test(excerpt);
      if (!unassisted && !mixed)
        throw Error(
          "Assisted source work cannot become independent imported proof",
        );
    }
    if (m.outcome === "contradicted" && numeric >= 2)
      throw Error(
        "Successful source evidence cannot be relabeled as a contradiction",
      );
  }
  return true;
}

export function importedProofValid(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  depth: number,
  facet: string,
  ref: string,
  outcome: FacetProof["outcome"] = "independent",
) {
  if (observationInvalidated(r, l, id, ref)) return false;
  const scopeId = scopeKey(id, depth);
  for (const receipt of [...(l.roadmapAdoptions ?? [])].reverse())
    for (const mapping of receipt.proposal.mappings) {
      if (
        mapping.scopeId !== scopeId ||
        mapping.facet !== facet ||
        mapping.outcome !== outcome ||
        !mapping.evidenceIds.includes(ref)
      )
        continue;
      try {
        return importedMappingValid(r, l, receipt, mapping);
      } catch {
        return false;
      }
    }
  return false;
}

const adoptedTrackProgress = (l: LearnerLedger | undefined, track: Track) =>
  adoptedSourceText(l)
    ?.split(`<!-- BEGIN ${track}_PROGRESS -->`)[1]
    ?.split(`<!-- END ${track}_PROGRESS -->`)[0];

export const trackProgressContext = (
  l: LearnerLedger | undefined,
  r: Roadmap,
  track: Track,
) => adoptedTrackProgress(l, track) ?? r.tracks[track].progress;

/**
 * The practical environment status restored by adopted roadmaps. Every
 * adoption's mapping is checked against its own source row, and the latest
 * adoption that maps this item supersedes earlier ones: a later reviewed
 * document can lower an imported status as well as raise it. Locally reviewed
 * work is combined separately (`environmentStatus`), and adoption itself
 * refuses to erase a qualifying pass.
 */
function importedEnvironment(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  scope: string,
) {
  let latest:
    { status: "U" | "G" | "P"; refs: string[]; note: string } | undefined;
  for (const receipt of l.roadmapAdoptions ?? [])
    for (const m of receipt.proposal.environment ?? []) {
      if (m.envId !== id) continue;
      const c = receiptCells(
        receipt,
        "PE_PROGRESS/0.8.1 Environment-backed verification/",
        id.split(":")[1],
      );
      if (
        receipt.sourceHash !== r.sourceHash ||
        !PROVIDERS.includes(receipt.provenance) ||
        !c ||
        `${c[1]}; related scope ${c[2]}` !== scope ||
        c[3] !== m.status ||
        !["U", "G", "P"].includes(m.status) ||
        !m.rationale?.trim() ||
        !Array.isArray(m.evidenceIds) ||
        (m.status !== "U" &&
          (!m.evidenceIds.length ||
            m.evidenceIds.some((ref) => !c[4].split(/[\s,;]+/).includes(ref)) ||
            c[5] === "—"))
      )
        throw Error("Unsupported imported practical environment status");
      latest = { status: m.status, refs: m.evidenceIds, note: c[5] };
    }
  return latest;
}

export function importedEnvironmentStatus(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  scope: string,
) {
  return importedEnvironment(r, l, id, scope)?.status ?? "U";
}

/** Only references from the source row that set the imported status. */
export function importedEnvironmentEvidence(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  scope: string,
) {
  const latest = importedEnvironment(r, l, id, scope);
  return latest && latest.status !== "U"
    ? { refs: [...new Set(latest.refs)], notes: [latest.note] }
    : { refs: [], notes: [] };
}
