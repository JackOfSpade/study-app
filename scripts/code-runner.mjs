import {
  codePacket,
  pythonBootstrap,
  nodeBootstrap,
} from "./runner-bootstrap.mjs";
import {
  docker,
  inspectImage,
  isLimitExit,
  maxOutput,
  removeContainer,
  sawMarker,
} from "./runner-process.mjs";
import { executeReact } from "./browser-runner.mjs";
import { browserSpec } from "./browser-runner/spec.mjs";
import { HttpInputError } from "./http-json.mjs";
import { randomUUID } from "node:crypto";
import { sha256 } from "./lib/digest.mjs";

const images = {
  python: process.env.CODE_RUNNER_PYTHON_IMAGE ?? "python:3.12-alpine",
  typescript: process.env.CODE_RUNNER_NODE_IMAGE ?? "node:22",
  javascript: process.env.CODE_RUNNER_NODE_IMAGE ?? "node:22",
};
const codeLimits = Object.freeze({
  memoryMiB: 128,
  cpus: 0.5,
  processes: 32,
  wallTimeMs: 5000,
  outputBytes: maxOutput,
});
let active = false;

/** Rejects a malformed request with 400; returns the validated React spec, if any. */
function validate(input) {
  if (
    !input ||
    !Object.hasOwn(images, input.language) ||
    typeof input.code !== "string" ||
    Buffer.byteLength(input.code, "utf8") > 65536
  )
    throw new HttpInputError(
      400,
      "Expected Python, TypeScript or JavaScript code up to 64 KiB",
    );
  if (input.environment !== undefined && input.environment !== "react")
    throw new HttpInputError(400, "Unsupported execution environment");
  if (input.environment !== "react") return undefined;
  if (input.language !== "typescript")
    throw new HttpInputError(400, "React execution requires TypeScript/TSX");
  try {
    return browserSpec(input.code, input.steps);
  } catch (error) {
    throw new HttpInputError(400, error.message);
  }
}

/** No host mounts, shell interpolation, network, or inherited host credentials. */
export async function executeCode(input) {
  const react = validate(input);
  if (active)
    throw new HttpInputError(
      409,
      "Runner busy; retry when the current run finishes",
    );
  active = true;
  try {
    return react
      ? await executeReact(react, randomUUID())
      : await executeInterpreter(input);
  } finally {
    active = false;
  }
}

async function executeInterpreter(input) {
  const id = randomUUID(),
    name = `study-code-${id}`,
    marker = `STUDY_INTERPRETER_${id}`;
  const startedAt = new Date().toISOString(),
    start = performance.now();
  let attemptedCreate = false;
  try {
    const imageId = await inspectImage(images[input.language]);
    if (!imageId)
      return {
        id,
        status: "unavailable",
        executed: false,
        language: input.language,
        detail:
          "Start Docker and install the configured runner image; code was not executed.",
      };
    const args = [
      "create",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534:65534",
      `--cpus=${codeLimits.cpus}`,
      `--memory=${codeLimits.memoryMiB}m`,
      `--memory-swap=${codeLimits.memoryMiB}m`,
      `--pids-limit=${codeLimits.processes}`,
      "--ulimit=cpu=3:3",
      "--ulimit=nofile=64:64",
      "--ulimit=core=0:0",
      "--ulimit=fsize=1048576:1048576",
      "--tmpfs=/work:rw,noexec,nosuid,nodev,size=8m,mode=1777",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777",
      "--workdir=/work",
      "--env=PYTHONDONTWRITEBYTECODE=1",
      "--env=PYTHONUNBUFFERED=1",
      "-i",
      imageId,
      "timeout",
      "-s",
      "KILL",
      "4",
    ];
    if (input.language === "python")
      args.push("python3", "-I", "-c", pythonBootstrap(marker));
    else
      args.push(
        "node",
        "--max-old-space-size=64",
        "-e",
        nodeBootstrap(marker, input.language),
      );
    // A killed create can still leave a container behind, so flag it first.
    attemptedCreate = true;
    const created = await docker(args);
    if (created.exitCode !== 0)
      return {
        id,
        status: "unavailable",
        executed: false,
        language: input.language,
        detail:
          "The isolated container could not be created; code was not executed.",
      };
    const result = await docker(["start", "--attach", "--interactive", name], {
      input: codePacket(input.code),
      timeout: codeLimits.wallTimeMs,
      onLimit: () => void removeContainer(name),
    });
    const executed = sawMarker(result, marker);
    return {
      id,
      language: input.language,
      imageId,
      startedAt,
      codeHash: sha256(input.code),
      durationMs: Math.round(performance.now() - start),
      status: !executed
        ? "unavailable"
        : (result.reason ??
          (isLimitExit(result.exitCode) ? "resource-limit" : "completed")),
      executed,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.replace(marker + "\n", ""),
      limits: { network: "none", hostMounts: false, ...codeLimits },
    };
  } finally {
    // Also clean up after a client/CLI failure or a process that forked children.
    if (attemptedCreate) await removeContainer(name);
  }
}
