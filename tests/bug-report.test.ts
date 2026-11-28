import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collapseRepeats,
  createBugReports,
} from "../scripts/bug-report-route.mjs";
import { buildClientReport } from "../src/bug-report";

const snapshot = (logs: string) => ({
  url: "http://127.0.0.1:5173/",
  userAgent: "test",
  viewport: "800×600 at 1x",
  view: "question",
  terminalOpen: true,
  connection: "claude-cli: ok",
  status: { save: "Saving study session…" },
  question: {
    title: "Late deliveries",
    provenance: "Claude CLI · Started in 4 earlier runs",
    state: "in-progress",
    prompt: "SECRET-PROMPT",
    messages: [{ kind: "human", author: "You", text: "SECRET-ANSWER" }],
    requests: [{ state: "interrupted", error: "timeout" }],
  },
  logs,
});
const logs = (entries: number) =>
  JSON.stringify({
    runs: [
      {
        id: "run-1",
        started: "2026-11-15",
        entries: Array.from({ length: entries }, (_, at) => ({
          at,
          type: "snapshot",
          data: "x".repeat(200),
        })),
        audit: { events: [{ type: "study-request", at: 1 }] },
      },
    ],
  });

test("the browser report carries hidden provenance and honours the opt-out", () => {
  const full = buildClientReport(snapshot(logs(3)), true);
  assert.match(full, /Started in 4 earlier runs/);
  assert.match(full, /SECRET-PROMPT/);
  assert.match(full, /interrupted \(timeout\)/);
  assert.doesNotMatch(full, /study-request|Lifecycle events|"audit"/);
  assert.match(full, /"id": "run-1"/);
  const lean = buildClientReport(snapshot(logs(3)), false);
  assert.doesNotMatch(lean, /SECRET-PROMPT|SECRET-ANSWER/);
  assert.match(lean, /1 human/);
});

test("oversized diagnostics drop the oldest detail entries", () => {
  const report = buildClientReport(snapshot(logs(2000)), true, 40_000);
  assert.ok(report.length < 60_000);
  assert.match(report, /older omitted for size/);
  assert.match(report, /"at":1999/);
  assert.doesNotMatch(report, /"at":0,/);
  assert.match(buildClientReport(snapshot("{"), true), /could not be read/);
});

test("repeated crash blocks collapse to one copy and a count", () => {
  const block = ["Error: listen EADDRINUSE", "    at x", "Node.js v26"];
  assert.deepEqual(collapseRepeats([...block, ...block, ...block, "ok"]), [
    ...block,
    "… the previous 3 lines repeated 2 more times",
    "ok",
  ]);
  assert.deepEqual(collapseRepeats(["a", "b"]), ["a", "b"]);
});

async function withRoute(
  options: Record<string, unknown>,
  run: (
    post: (body: unknown, type?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  const directory = join(mkdtempSync(join(tmpdir(), "bug-report-")), "out");
  const reports = createBugReports({ directory, ...options });
  const server = createServer(async (req, res) => {
    try {
      if (!(await reports.route(req, res))) res.writeHead(404).end();
    } catch (error) {
      res.writeHead((error as { status?: number }).status ?? 500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  try {
    await run((body, type = "application/json") =>
      fetch(`http://127.0.0.1:${port}/api/bug-report`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    server.close();
  }
  return directory;
}

test("saving writes one private file and copies only its path", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bug-report-logs-"));
  const log = join(scratch, "service.log");
  writeFileSync(log, "boot\nboom\nboom\nboom\n");
  const usageLog = join(scratch, "usage.jsonl");
  writeFileSync(
    usageLog,
    `${JSON.stringify({ at: "t", operation: "generate", outcome: "rejected", durationMs: 1500 })}\nnot json\n`,
  );
  let tick = Date.UTC(2026, 10, 15);
  const directory = await withRoute(
    {
      usageLog,
      logs: [{ title: "Bridge log", path: log }],
      status: () => "connected",
      now: () => tick++,
      limits: { retention: 2 },
    },
    async (post) => {
      const saved = await (
        await post({
          mode: "save",
          description: "It broke",
          client: "## Browser",
        })
      ).json();
      assert.equal(saved.delivery, "file-pointer");
      const markdown = readFileSync(saved.savedPath, "utf8");
      assert.match(markdown, /It broke/);
      assert.match(markdown, /## Browser/);
      assert.match(markdown, /Claude connection: connected/);
      assert.match(markdown, /generate .*rejected .*1\.5/);
      assert.match(markdown, /boom\n… the previous line repeated 2 more times/);
      assert.match(saved.clipboardText, /It broke/);
      assert.ok(saved.clipboardText.includes(saved.savedPath));
      assert.doesNotMatch(saved.clipboardText, /## Browser/);
      for (let i = 0; i < 3; i++)
        await post({ mode: "save", description: "", client: "" });
      const rendered = await (
        await post({ mode: "render", description: "", client: "" })
      ).json();
      assert.match(rendered.markdown, /No description given/);
      assert.equal((await post({ mode: "save" })).status, 400);
      assert.equal(
        (
          await post(
            { mode: "save", description: "", client: "" },
            "text/plain",
          )
        ).status,
        415,
      );
    },
  );
  // Rendering saves nothing, and only the newest two reports are kept.
  assert.equal(readdirSync(directory).length, 2);
});

test("the AI call table reads today's usage rows and lists them by start time", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bug-report-usage-rows-"));
  const usageLog = join(scratch, "usage.jsonl");
  const row = (over: object) =>
    JSON.stringify({ outcome: "accepted", durationMs: 1000, ...over });
  writeFileSync(
    usageLog,
    [
      // The long assess call began first and ended last, so the log holds it last.
      row({
        at: "2026-11-23T07:59:20.000Z",
        operation: "tutor",
        mode: "terminal-review",
        turn: 11,
      }),
      row({ at: "2026-11-23T07:59:15.000Z", operation: "assess" }),
      row({
        at: "2026-11-23T07:57:18.000Z",
        operation: "tutor",
        mode: "terminal-dialogue",
        turn: 7,
        part: 2,
        ofParts: 3,
      }),
      row({ at: "2026-11-23T07:00:00.000Z", operation: "generate", parts: 3 }),
      row({ at: "2026-11-23T07:30:00.000Z", operation: "generate", parts: 1 }),
      row({
        at: "2026-11-23T07:31:00.000Z",
        operation: "generate",
        stage: "review",
        review: "revised",
        parts: 1,
      }),
      row({
        at: "2026-11-23T06:00:00.000Z",
        operation: "generate",
        parts: null,
      }),
      row({
        at: "2026-11-01T00:00:00.000Z",
        operation: "tutor",
        phase: "old-phase",
        conversationTurn: 4,
      }),
    ].join("\n"),
  );
  await withRoute({ usageLog }, async (post) => {
    const { markdown } = await (
      await post({ mode: "render", description: "", client: "" })
    ).json();
    const rows = (markdown as string)
      .split("\n")
      .filter((line) => line.startsWith("| 2026"));
    assert.deepEqual(
      rows.map((line) => line.split(" | ").slice(0, 4).join(" | ")),
      [
        "| 2026-11-01T00:00:00.000Z | tutor | old-phase | 4",
        "| 2026-11-23T06:00:00.000Z | generate |  | ",
        "| 2026-11-23T07:00:00.000Z | generate | 3 parts | ",
        "| 2026-11-23T07:30:00.000Z | generate | 1 part | ",
        "| 2026-11-23T07:31:00.000Z | generate | review: revised | ",
        "| 2026-11-23T07:57:18.000Z | tutor | terminal-dialogue | 7 (part 2/3)",
        "| 2026-11-23T07:59:15.000Z | assess |  | ",
        "| 2026-11-23T07:59:20.000Z | tutor | terminal-review | 11",
      ],
    );
    assert.match(markdown, /Newest 8 of the usage log; 0 did not end accepted/);
    assert.match(
      markdown,
      /say when each call started; rows are in that order/,
    );
  });
});

test("a usage log line that is valid JSON but not a row never fails the report", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bug-report-usage-"));
  const usageLog = join(scratch, "usage.jsonl");
  writeFileSync(
    usageLog,
    `null\n7\n[1]\n${JSON.stringify({ at: "t", operation: "tutor", outcome: "accepted", durationMs: 2500 })}\n`,
  );
  await withRoute({ usageLog }, async (post) => {
    const response = await post({
      mode: "render",
      description: "",
      client: "",
    });
    assert.equal(response.status, 200);
    const { markdown } = await response.json();
    assert.match(markdown, /Newest 1 of the usage log; 0 did not end accepted/);
    assert.match(markdown, /tutor .*accepted .*2\.5/);
  });
});
