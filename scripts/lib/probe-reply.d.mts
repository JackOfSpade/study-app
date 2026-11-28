export const FINDING_STATUSES: readonly ["demonstrated", "implied", "gap"];
export const FLUENCY: readonly [
  "fluent",
  "partial",
  "guessing",
  "declared-gap",
];
export const OUTCOMES: readonly ["solved", "gap"];
/** `outcome` absent, or one of the allowed values. */
export function validProbeOutcome(args: Record<string, unknown>): boolean;
/** `knowledge` absent, or {facets?:[...],signal?:{fluency,note?}}. */
export function validProbeKnowledge(args: Record<string, unknown>): boolean;
