/** Small DOM and display helpers shared by the application shell and its panels. */

/** The element a selector names. The shell's markup is static, so it exists. */
export const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

// Open panels re-render on every UI tick. Rewriting unchanged text or markup
// replaces nodes, which clears any selection the learner is making, so panel
// writes only touch the DOM when the content actually changes.
export function setNodeText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export function setText(selector: string, text: string) {
  setNodeText($(selector), text);
}

const writtenHtml = new WeakMap<Element, string>();

/** Writes markup unless it is what was last written here; says if it wrote. */
export function setHtml(el: Element, html: string): boolean {
  // Compare with what was written: the browser normalises innerHTML (for
  // example &#39; reads back as '), so reading it back never matches.
  if (writtenHtml.get(el) === html) return false;
  writtenHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

/** Offers text as a file download. The object URL outlives the click long
 * enough for a large backup to be read before it is revoked. */
export function download(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Elapsed time as m:ss. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
