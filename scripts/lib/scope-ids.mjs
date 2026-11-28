/**
 * The identifiers of a scope definition, shared by the app's learner ledger
 * (src/learning-model.ts) and the relay's generate validator, so a reply the
 * app would refuse is sent back for its one correction inside the same call
 * instead of being generated again from scratch.
 */

/** A stable facet id: 1 to 100 letters, digits, `_`, `-` or `.`. */
export const FACET_ID = /^[-\w.]{1,100}$/;

/** A Tier-4 transfer or integration requirement (`PE:T05`, `PY:I01`). */
export const isFinalTarget = (id) => /^(PY|PE):(?:[TX]\d{2}|I\d{2})$/.test(id);

/** The id of an objective's scope definition at a depth. */
export const scopeKey = (id, depth) =>
  `${id}/${isFinalTarget(id) ? "T4" : `D${depth}`}`;

/**
 * Why a reply's scope definitions would be refused for this contract, or
 * undefined when they would not. Mirrors the structural checks of
 * `registerScopes`; the source scope text is checked when the contract lists
 * one scope per objective.
 */
export function scopeDefinitionProblem(contract, definitions) {
  const objectives = Array.isArray(contract?.objectiveIds)
    ? contract.objectiveIds
    : [];
  for (const d of Array.isArray(definitions) ? definitions : []) {
    if (!d || typeof d !== "object")
      return "Each scope definition must be an object";
    if (!objectives.includes(d.objectiveId))
      return `scopeDefinitions objectiveId ${JSON.stringify(d.objectiveId)} is not one of the contract's objectiveIds`;
    if (d.depth !== contract.depth)
      return `scopeDefinitions depth must be the contract depth ${contract.depth}`;
    const id = scopeKey(d.objectiveId, d.depth);
    if (d.id !== id)
      return `scopeDefinitions id must be exactly ${JSON.stringify(id)} (got ${JSON.stringify(d.id)})`;
    const scopes = contract.scopes;
    if (
      Array.isArray(scopes) &&
      scopes.length === objectives.length &&
      (contract.kind ?? "checkpoint") === "checkpoint" &&
      d.sourceScope !== scopes[objectives.indexOf(d.objectiveId)]
    )
      return `scopeDefinitions sourceScope for ${d.objectiveId} must copy the contract's scope text exactly`;
    const bad = (Array.isArray(d.facets) ? d.facets : [])
      .map((f) => f?.id)
      .find((fid) => typeof fid !== "string" || !FACET_ID.test(fid));
    if (bad !== undefined)
      return `Facet id ${JSON.stringify(bad)} is not allowed: use a short slug of letters, digits, '-', '_' or '.' (for example boundary-case), with no ':' or '/'`;
  }
  return undefined;
}
