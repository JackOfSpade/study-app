export const FINDING_STATUSES: readonly ["demonstrated", "implied", "gap"];
export const FLUENCY: readonly [
  "fluent",
  "partial",
  "guessing",
  "declared-gap",
];
export const OUTCOMES: readonly ["solved", "gap"];
/** JSON Schema properties for the optional probe fields of a reply tool. */
export function probeReplyProperties(): Record<string, unknown>;
/** `outcome` absent, or one of the allowed values. */
export function validProbeOutcome(args: Record<string, unknown>): boolean;
/** `knowledge` absent, or {facets?:[...],signal?:{fluency,note?}}. */
export function validProbeKnowledge(args: Record<string, unknown>): boolean;
/** Shape check matching the queue's terminal-dialogue validation. */
export function validProbeReply(args: Record<string, unknown>): boolean;
/** The reply the app receives: text and complete, plus the optional probe fields when given. */
export function probeReplyFields(args: Record<string, unknown>): {
  text: unknown;
  complete: unknown;
  outcome?: unknown;
  knowledge?: unknown;
};
export const PROBE_REPLY_ERROR: string;
