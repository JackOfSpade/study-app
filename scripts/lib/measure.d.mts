export function isNumber(value: unknown): value is number;
export function sumKnown(values: readonly unknown[]): number | null;
export function mean(values: readonly unknown[]): number | null;
export function percentile(
  values: readonly unknown[],
  p: number,
): number | null;
