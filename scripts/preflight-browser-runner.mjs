// Run only a public fixed counter while verifying the candidate browser sandbox.
// This does not expose a learner-code endpoint or award practical/academic credit.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  browserContainerOptions,
  browserImage,
  browserLimits,
} from "./browser-container.mjs";
import { imageIdPattern } from "./runner-process.mjs";
const inspected = spawnSync(
    "docker",
    ["image", "inspect", browserImage(), "--format", "{{.Id}}"],
    { encoding: "utf8", timeout: 5000 },
  ),
  imageId = inspected.stdout?.trim();
if (inspected.status !== 0 || !imageIdPattern.test(imageId ?? ""))
  throw Error("Build this project's browser runtime image first");
const name = "study-browser-preflight-" + randomUUID(),
  args = [
    "run",
    ...browserContainerOptions(name),
    imageId,
    "node",
    "/opt/study-browser/preflight.mjs",
  ];
const startedAt = new Date().toISOString();
try {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 128 * 1024,
  });
  const report = {
    startedAt,
    imageId,
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout,
    stderr: result.stderr,
    limits: {
      network: "none",
      rootFilesystem: "read-only",
      capabilities: "none",
      newPrivileges: false,
      ipc: "private",
      memoryMiB: browserLimits.memoryMiB,
      pids: browserLimits.processes,
      cpus: browserLimits.cpus,
      wallSeconds: 20,
      hostMounts: false,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (result.status !== 0 || result.error) process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "--force", name], {
    encoding: "utf8",
    timeout: 5000,
  });
}
