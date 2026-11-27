/**
 * Splits a Markdown table row on its cell separators. A pipe written as `\|`
 * (the Markdown escape) belongs to the cell text, so an observation, rationale
 * or quote containing one stays in one cell instead of cutting the row short.
 * A pipe after an even run of backslashes (`\\|`) is still a separator. Use it
 * exactly like `line.split("|")`: the leading and trailing empty strings
 * around the outer pipes are kept, so existing cell indexes are unchanged.
 * Exports write `|` as `&#124;`; this protects documents from elsewhere.
 */
export const CELL_SEPARATOR = /(?<!(?:^|[^\\])(?:\\\\)*\\)\|/;

/** A table row's trimmed cells without the empty strings around its outer
 * pipes, so the first cell is index 0 (unlike `line.split(CELL_SEPARATOR)`). */
export const tableCells = (line: string) =>
  line
    .split(CELL_SEPARATOR)
    .slice(1, -1)
    .map((cell) => cell.trim());
