/** Small numeric helpers shared by the measurement scripts. Unknown values
 * (null, undefined, NaN, non-numbers) are always skipped, never counted. */

export const isNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/** Sum of the known numbers, or null when there is none. */
export const sumKnown = (values) => {
  const known = values.filter(isNumber);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};

/** Mean of the known numbers, or null when there is none. */
export const mean = (values) => {
  const known = values.filter(isNumber);
  return known.length
    ? known.reduce((total, value) => total + value, 0) / known.length
    : null;
};

/** Nearest-rank percentile over the known numbers, or null when there is none. */
export function percentile(values, p) {
  const sorted = values.filter(isNumber).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
