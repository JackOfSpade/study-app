export const PARTS_GENERATION_GUIDANCE: string;
export const PARTS_TUTOR_GUIDANCE: string;
export const PART_SOLVE_SECONDS_MAX: number;
export function partsProblem(parts: unknown): string | undefined;
export function partSizeProblem(answer: unknown): string | undefined;
export function partRequests(part: unknown): string[];
export function compoundPartProblem(parts: unknown): string | undefined;
export function composePrompt(shared: string, parts: string[]): string;
export function stagedParts(problem: unknown): string[] | undefined;
export function closesPart(
  payload: unknown,
  answer: Record<string, unknown>,
): boolean;
export function partReplyProblem(
  payload: unknown,
  answer: Record<string, unknown>,
): string | undefined;
