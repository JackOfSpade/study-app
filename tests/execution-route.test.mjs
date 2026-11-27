import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { executionRoute } from "../scripts/execution-route.mjs";

/** Drive the route with an in-memory request; no Docker is needed for these answers. */
async function post(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  const res = {
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = JSON.parse(text);
    },
  };
  await executionRoute(req, res);
  return res;
}

test("malformed execution requests are 400 with the validation message", async () => {
  for (const [body, message] of [
    [{ language: "bash", code: "echo forbidden" }, /Expected/],
    [{ language: "python", code: "x".repeat(65537) }, /64 KiB/],
    [
      { language: "python", code: "", environment: "vm" },
      /Unsupported execution environment/,
    ],
    [
      { language: "python", code: "", environment: "react" },
      /requires TypeScript/,
    ],
    [
      { language: "typescript", code: "", environment: "react", steps: null },
      /Browser checks must be a list/,
    ],
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, message);
    assert.match(res.body.error, /^Error: /);
  }
});

test("a second run while one is active is 409 busy", async () => {
  const first = post({ language: "python", code: "print(1)" });
  const second = await post({ language: "python", code: "print(2)" });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /Runner busy/);
  // Without Docker the first run is unavailable; with it, it completes.
  assert.ok([200, 503].includes((await first).status));
});
