import { isRecord } from "./records";

/** The longest completion feedback a verdict may carry. */
export const FEEDBACK_LIMIT = 8000;

export function completionVerdict(value: unknown): {
  complete: boolean;
  feedback: string;
  qualified: string[];
} {
  if (
    !isRecord(value) ||
    typeof value.complete !== "boolean" ||
    typeof value.feedback !== "string" ||
    !value.feedback.trim() ||
    value.feedback.length > FEEDBACK_LIMIT ||
    !Array.isArray(value.qualified) ||
    value.qualified.length > 128 ||
    !value.qualified.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
    )
  )
    throw Error("Malformed completion response");
  return {
    complete: value.complete,
    feedback: value.feedback,
    qualified: [...new Set(value.qualified as string[])],
  };
}
