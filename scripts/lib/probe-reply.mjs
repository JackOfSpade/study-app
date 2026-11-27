import { isRecord as object } from "./is-record.mjs";

/**
 * Knowledge-probe reply checks used by the relay's validator (ai-contracts.mjs).
 * The app validates the same shape again in src/knowledge-probe.ts
 * (parseProbeReply).
 */
export const FINDING_STATUSES = ["demonstrated", "implied", "gap"];
export const FLUENCY = ["fluent", "partial", "guessing", "declared-gap"];
export const OUTCOMES = ["solved", "gap"];
const optionalString = (value) =>
  value === undefined || typeof value === "string";

/** `outcome` absent, or one of the allowed values. */
export const validProbeOutcome = (args) =>
  args.outcome === undefined || OUTCOMES.includes(args.outcome);

/** `knowledge` absent, or {facets?:[{id,status,impliedBy?,note?,partOf?,description?}],signal?:{fluency,note?}}. */
export function validProbeKnowledge(args) {
  if (args.knowledge === undefined) return true;
  const k = args.knowledge;
  if (!object(k)) return false;
  if (
    k.facets !== undefined &&
    (!Array.isArray(k.facets) ||
      k.facets.length > 64 ||
      k.facets.some(
        (f) =>
          !object(f) ||
          typeof f.id !== "string" ||
          !FINDING_STATUSES.includes(f.status) ||
          !optionalString(f.impliedBy) ||
          !optionalString(f.note) ||
          !optionalString(f.partOf) ||
          !optionalString(f.description),
      ))
  )
    return false;
  if (
    k.signal !== undefined &&
    (!object(k.signal) ||
      !FLUENCY.includes(k.signal.fluency) ||
      !optionalString(k.signal.note))
  )
    return false;
  return true;
}
