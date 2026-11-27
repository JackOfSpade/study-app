import { outputCapture } from "./runner-output.mjs";
import { spawn } from "node:child_process";

export const maxOutput = 65536;
/** Exit codes of `timeout -s KILL` (124), SIGKILL/OOM (137) and SIGXCPU (152). */
const limitExitCodes = new Set([124, 137, 152]);
export const isLimitExit = (exitCode) => limitExitCodes.has(exitCode);
export const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export function docker(
  args,
  { input = "", timeout = 5000, onLimit, outputLimit = maxOutput } = {},
) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = outputCapture(outputLimit);
    let reason;
    const stop = (why) => {
      if (reason) return;
      reason = why;
      onLimit?.();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), timeout);
    const capture = (stream) => (chunk) => {
      if (output.push(stream, chunk)) stop("output-limit");
    };
    child.stdout.on("data", capture("out"));
    child.stderr.on("data", capture("err"));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      reason ??= "unavailable";
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const { stdout, stderr, stderrPrefix } = output.result();
      resolve({ stdout, stderr, stderrPrefix, exitCode, reason });
    });
    child.stdin.end(input);
  });
}

/** The local image's content id, or undefined when Docker or the image is missing. */
export async function inspectImage(ref) {
  const image = await docker(["image", "inspect", ref, "--format", "{{.Id}}"]);
  const imageId = image.stdout.trim();
  return image.exitCode === 0 && imageIdPattern.test(imageId)
    ? imageId
    : undefined;
}

export const removeContainer = (name) => docker(["rm", "--force", name]);

/** The in-container program wrote its start marker as a whole stderr line. */
export const sawMarker = (result, marker) =>
  result.stderrPrefix.split("\n").includes(marker);
