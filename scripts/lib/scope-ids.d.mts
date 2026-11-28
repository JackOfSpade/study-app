export const FACET_ID: RegExp;
export function isFinalTarget(id: string): boolean;
export function scopeKey(id: string, depth: number): string;
export function scopeDefinitionProblem(
  contract: unknown,
  definitions: unknown,
): string | undefined;
