import { sha256 } from "./lib/digest.mjs";
import {
  docker,
  inspectImage,
  isLimitExit,
  removeContainer,
  sawMarker,
} from "./runner-process.mjs";
import { boundedText } from "./runner-output.mjs";
import {
  browserContainerOptions,
  browserImage,
  browserLimits,
} from "./browser-container.mjs";
import { browserSpecText } from "./browser-runner/spec.mjs";

/** Keep the readable form when it fits; never cut a report into invalid JSON unless it cannot fit at all. */
function observationText(observed, budget) {
  const pretty = JSON.stringify(observed, null, 2);
  return boundedText(
    Buffer.byteLength(pretty) <= budget ? pretty : JSON.stringify(observed),
    budget,
  );
}

/** Runs a spec already validated by browserSpec in the isolated browser container. */
export async function executeReact(spec, id) {
  const name = "study-browser-run-" + id,
    marker = "STUDY_REACT_" + id,
    startedAt = new Date().toISOString(),
    start = performance.now(),
    base = {
      id,
      language: "typescript",
      environment: "react",
      startedAt,
      codeHash: sha256(spec.code),
      specHash: sha256(browserSpecText(spec.code, spec.steps)),
      limits: { network: "none", hostMounts: false, ...browserLimits },
    };
  let attemptedCreate = false;
  try {
    const imageId = await inspectImage(browserImage());
    if (!imageId)
      return {
        ...base,
        status: "unavailable",
        executed: false,
        detail: "Build the isolated React runtime image first; no code ran.",
      };
    const args = [
      "create",
      ...browserContainerOptions(name),
      "-i",
      imageId,
      "timeout",
      "-s",
      "KILL",
      "14",
      "node",
      "/opt/study-browser/runner.mjs",
    ];
    // A killed create can still leave a container behind, so flag it first.
    attemptedCreate = true;
    const created = await docker(args);
    if (created.exitCode !== 0)
      return {
        ...base,
        imageId,
        status: "unavailable",
        executed: false,
        detail:
          "The isolated React container could not start; no learner code ran.",
      };
    const result = await docker(["start", "--attach", "--interactive", name], {
        input: JSON.stringify({ ...spec, marker }) + "\n",
        timeout: browserLimits.wallTimeMs,
        onLimit: () => void removeContainer(name),
        outputLimit: browserLimits.outputBytes,
      }),
      executed = sawMarker(result, marker);
    let observed;
    try {
      observed = JSON.parse(result.stdout);
    } catch {
      /* Limits can interrupt a complete report. Keep raw bounded output. */
    }
    let preview;
    if (
      executed &&
      observed?.preview?.mimeType === "image/jpeg" &&
      typeof observed.preview.base64 === "string" &&
      observed.preview.base64.length <= 180000
    ) {
      const bytes = Buffer.from(observed.preview.base64, "base64");
      if (
        bytes.length > 4 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes.at(-2) === 255 &&
        bytes.at(-1) === 217
      )
        preview = {
          dataUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
          width: 640,
          height: 400,
          sha256: sha256(bytes),
        };
    }
    if (observed) delete observed.preview;
    const compileError = observed?.kind === "compile-error",
      status =
        result.reason ??
        (observed?.timedOut
          ? "timeout"
          : isLimitExit(result.exitCode)
            ? "resource-limit"
            : !executed && !compileError
              ? "unavailable"
              : "completed");
    return {
      ...base,
      imageId,
      durationMs: Math.round(performance.now() - start),
      status,
      executed,
      exitCode: result.exitCode,
      stdout: observed
        ? observationText(observed, browserLimits.outputBytes)
        : result.stdout,
      stderr: boundedText(result.stderr.replace(marker + "\n", ""), 8192),
      ...(preview ? { preview } : {}),
      detail: compileError
        ? "TSX compilation failed; browser code was not executed."
        : !executed
          ? "Browser execution could not begin; no execution credit."
          : undefined,
    };
  } finally {
    if (attemptedCreate) await removeContainer(name);
  }
}
