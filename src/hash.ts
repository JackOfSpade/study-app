import { isRecord } from "./records";

/** 32-bit FNV-1a hash over UTF-16 code units.
 * Determinism-critical: keep iteration order and constant multipliers bit-identical. */
export function fnv1a(text: string, seed = 2166136261): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** The checksummed envelope saved records are stored in. Protected format:
 * keep the key order, the schema value and the serialisation unchanged. */
export function sealEnvelope(payload: string) {
  return JSON.stringify({ schema: 1, payload, checksum: fnv1a(payload) });
}

/** The payload of a sound envelope, or undefined when its shape or checksum
 * fails. Text that is not JSON throws the parser's error. */
export function openEnvelope(text: string): string | undefined {
  const e: unknown = JSON.parse(text);
  return isRecord(e) &&
    e.schema === 1 &&
    typeof e.payload === "string" &&
    fnv1a(e.payload) === e.checksum
    ? e.payload
    : undefined;
}
