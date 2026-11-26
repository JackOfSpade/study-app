import { isRecord } from "./records";
/** Provider transport only; learning stays in its owning modules. */
type DisconnectReason =
  "relay-unreachable" | "gateway-off" | "cli-missing" | "signed-out";
const REASONS: readonly unknown[] = [
  "relay-unreachable",
  "gateway-off",
  "cli-missing",
  "signed-out",
];
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
        ...(REASONS.includes(info.reason)
          ? { reason: info.reason as DisconnectReason }
          : {}),
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
export const INTERRUPTED_MESSAGE =
  "The connection to the study relay was lost before the reply arrived. The saved request is sent again automatically once the relay is reachable.";
/** Whether a failed request may be sent again unchanged without asking. */
export const isInterruption = (error: unknown) =>
  error instanceof BridgeInterrupted;
/** True once the request's own wait budget or its owner ended it: a failure
 * after that is that decision, never a cut line. */
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
        // A final line may arrive without its newline.
        const answer = streamEvent(buffer, onText);
        if (answer) return answer;
        throw new BridgeInterrupted(
          "The reply ended before its answer arrived. The saved request is sent again automatically.",
        );
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
  /** Cancel optional presentation work when its owner is no longer active. */
  signal?: AbortSignal;
  /** Wait budget; bounded to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Receives the reply's text so far while Claude CLI is still writing it. */
  onText?: (text: string) => void;
  /** Stop waiting once the request's owner is gone. */
  isActive?: () => boolean;
}
/** T describes the operation reply; domain callers still validate its contents. */
export async function bridgeRequest<T extends object = Record<string, unknown>>(
  operation: string,
  payload: unknown,
  options?: BridgeRequestOptions,
) {
  if (options?.isActive?.() === false)
    throw Error("Study session closed; saved work retained");
  const provider = status().mode;
  const requested = options?.timeoutMs;
  const budget =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, REQUEST_TIMEOUT_MS)
      : REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(
    provider === "claude-cli" ? budget : Math.min(budget, 45000),
  );
  const signal = options?.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const body = JSON.stringify({
    operation,
    payload,
    provider,
    ...(provider === "claude-cli" && options?.onText ? { stream: true } : {}),
  });
  const decided = () => !!options?.signal?.aborted || timeout.aborted;
  let r: Response;
  try {
    r = await fetch("/api/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });
  } catch (error) {
    // The owner's own cancel and the wait budget are decisions, not a cut line.
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
