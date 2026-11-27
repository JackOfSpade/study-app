import { isRecord } from "./records";
/** Provider transport only; learning stays in its owning modules. */
const REASONS = [
  "relay-unreachable",
  "gateway-off",
  "cli-missing",
  "signed-out",
] as const;
type DisconnectReason = (typeof REASONS)[number];
const isReason = (v: unknown): v is DisconnectReason =>
  (REASONS as readonly unknown[]).includes(v);
export interface BridgeStatus {
  /** "development" means Claude is not connected, so questions are locked. */
  mode: "development" | "claude-cli";
  label: string;
  reason?: DisconnectReason;
  capabilities: string[];
  detail: string;
}
let bridgeStatus: BridgeStatus = {
  mode: "development",
  label: "Claude not connected",
  reason: "relay-unreachable",
  capabilities: [],
  detail: "Claude CLI study connection is not available.",
};
export const status = () => bridgeStatus;
let checkVersion = 0;
export async function checkBridge() {
  const version = ++checkVersion;
  try {
    const r = await fetch("/api/status", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error();
    const info = await r.json();
    if (
      !isRecord(info) ||
      (info.mode !== "development" && info.mode !== "claude-cli") ||
      !Array.isArray(info.capabilities) ||
      !info.capabilities.every((cap: unknown) => typeof cap === "string") ||
      typeof info.label !== "string" ||
      typeof info.detail !== "string"
    )
      throw Error("Malformed bridge capability handshake");
    if (version === checkVersion)
      bridgeStatus = {
        mode: info.mode,
        label: info.label,
        ...(isReason(info.reason) ? { reason: info.reason } : {}),
        capabilities: info.capabilities,
        detail: info.detail,
      };
  } catch {
    if (version === checkVersion)
      bridgeStatus = {
        mode: "development",
        label: "Claude not connected",
        reason: "relay-unreachable",
        capabilities: [],
        detail: "The study relay is not reachable.",
      };
  }
  return bridgeStatus;
}
/** How long one request waits for the bridge to answer. */
const REQUEST_TIMEOUT_MS = 30 * 60_000;
const INTERRUPTED_MESSAGE =
  "The connection to the study relay was lost before the reply arrived. The saved request is sent again automatically once the relay is reachable.";
const ENDED_EARLY_MESSAGE =
  "The reply ended before its answer arrived. The saved request is sent again automatically.";
/**
 * The request never got its answer because the way to the relay was cut: the
 * page was closing or reloading, the relay was restarting or unreachable, or
 * the reply stream broke off. Nothing was decided about the request, so its
 * owner keeps it and sends the same saved request again once the relay can be
 * reached. A reply the relay or Claude refused is never one of these.
 */
export class BridgeInterrupted extends Error {
  // Shown to the learner as "Error: …", like every other failed request.
  readonly interrupted = true;
  constructor(message = INTERRUPTED_MESSAGE) {
    super(message);
  }
}
/** Whether a failed request may be sent again unchanged without asking. */
export const isInterruption = (error: unknown) =>
  error instanceof BridgeInterrupted;
/** True once the request's own wait budget ended it: a failure after that is
 * that decision, never a cut line. */
type Decided = () => boolean;
const cutUnlessDecided = (decided: Decided, error: unknown) => {
  if (decided()) return error;
  return new BridgeInterrupted();
};
/** Bridge errors may come from a proxy as plain text; never surface a JSON
 * parse failure in place of the real reason. */
async function readJson(r: Response, decided: Decided) {
  let text: string;
  try {
    text = await r.text();
  } catch (error) {
    // The body broke off while it was being read.
    throw cutUnlessDecided(decided, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (r.ok) throw Error("Malformed bridge response");
    if (r.status >= 502 && r.status <= 504)
      throw new BridgeInterrupted(
        "The study bridge is not running. It is restarting; the saved request is sent again once it is back. Your work is saved.",
      );
    return { error: text.trim().slice(0, 200) || `Bridge HTTP ${r.status}` };
  }
  if (!isRecord(data)) throw Error("Malformed bridge response");
  return data;
}
/** One stream line: the final answer, or undefined after a progress line. */
function streamEvent(line: string, onText: (text: string) => void) {
  // Blank keep-alive lines carry nothing.
  if (!line.trim()) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    throw Error("Malformed bridge response");
  }
  if (!isRecord(event)) throw Error("Malformed bridge response");
  if (typeof event.error === "string") throw Error(event.error);
  if (isRecord(event.answer)) return event.answer;
  if (typeof event.text === "string")
    try {
      onText(event.text);
    } catch {
      // Progress is display only: a failed repaint must not cost the answer.
    }
  return undefined;
}
/** Each line is the text so far, then one final answer or error. */
async function readStream(
  r: Response,
  onText: (text: string) => void,
  decided: Decided,
) {
  if (!r.body) throw Error("Malformed bridge response");
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The stream broke off: the page is closing or the relay went away.
        throw cutUnlessDecided(decided, error);
      }
      const { value, done } = chunk;
      if (done) {
        // A final line may arrive without its newline. The relay ends every
        // line with one, so leftover text that is not JSON was cut off.
        let answer;
        try {
          answer = streamEvent(buffer, onText);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Malformed bridge response" ||
            !buffer.trim()
          )
            throw error;
        }
        if (answer) return answer;
        throw new BridgeInterrupted(ENDED_EARLY_MESSAGE);
      }
      buffer += value;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const answer = streamEvent(buffer.slice(0, at), onText);
        buffer = buffer.slice(at + 1);
        if (answer) return answer;
      }
    }
  } finally {
    // The answer or an error ends the exchange: never leave the stream open.
    void reader.cancel().catch(() => {});
  }
}
interface BridgeRequestOptions {
  /** Receives the reply's text so far while Claude CLI is still writing it. */
  onText?: (text: string) => void;
}
/** T describes the operation reply; domain callers still validate its contents. */
export async function bridgeRequest<T extends object = Record<string, unknown>>(
  operation: string,
  payload: unknown,
  options?: BridgeRequestOptions,
) {
  const provider = status().mode;
  const timeout = AbortSignal.timeout(
    provider === "claude-cli" ? REQUEST_TIMEOUT_MS : 45000,
  );
  const body = JSON.stringify({
    operation,
    payload,
    provider,
    ...(provider === "claude-cli" && options?.onText ? { stream: true } : {}),
  });
  const decided = () => timeout.aborted;
  let r: Response;
  try {
    r = await fetch("/api/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: timeout,
    });
  } catch (error) {
    // The wait budget running out is a decision, not a cut line.
    throw cutUnlessDecided(decided, error);
  }
  if (
    options?.onText &&
    r.headers.get("Content-Type")?.includes("application/x-ndjson")
  )
    return (await readStream(r, options.onText, decided)) as T;
  const data = await readJson(r, decided);
  if (!r.ok) {
    const message =
      typeof data.error === "string" ? data.error : "Bridge request failed";
    // The app server answers 502 itself, with no gateway code, while the
    // relay restarts; the relay answers 499 for a call whose caller went
    // away. A gateway failure also says 502 but names its code.
    if (
      r.status === 499 ||
      (r.status === 502 &&
        data.code === undefined &&
        /^Study bridge unavailable/.test(message))
    )
      throw new BridgeInterrupted(message);
    throw Error(message);
  }
  return data as T;
}
