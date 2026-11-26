import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BridgeInterrupted,
  bridgeRequest,
  checkBridge,
  isInterruption,
  status,
} from "../src/bridge-client";
const reply = (mode = "claude-cli") =>
  Response.json({
    mode,
    label: "Synthetic bridge",
    capabilities: ["generate"],
    detail: "Local fixture only",
  });
test("overlapping bridge checks cannot let an old failure replace a newer connection", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let fail!: (error: Error) => void,
    calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (calls++ === 0)
      return new Promise<Response>((_resolve, reject) => {
        fail = reject;
      });
    return reply();
  };
  const older = checkBridge();
  await checkBridge();
  fail(Error("Old request failed"));
  await older;
  assert.equal(status().mode, "claude-cli");
});

test("malformed bridge capabilities and retired providers fail closed", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [
    null,
    {},
    { mode: "claude-cli", label: "fake", detail: "bad", capabilities: [42] },
    // A bridge that still reports a retired provider is unusable, not trusted.
    { mode: "chatgpt-handoff", label: "old", detail: "old", capabilities: [] },
    { mode: "study-mode", label: "old", detail: "old", capabilities: [] },
  ]) {
    globalThis.fetch = async () => Response.json(body);
    await checkBridge();
    assert.equal(status().mode, "development");
  }
});

test("invalid bridge response bodies report a protocol error instead of a property access failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [null, [], "invalid"]) {
    globalThis.fetch = async (url) =>
      url === "/api/status" ? reply() : Response.json(body);
    await checkBridge();
    await assert.rejects(
      bridgeRequest("tutor", {}),
      /Malformed bridge response/,
    );
  }
});

test("a session already closed before submission never releases a bridge request", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  await assert.rejects(
    bridgeRequest("tutor", {}, { isActive: () => false }),
    /session closed/,
  );
  assert.equal(calls, 0);
});

test("successful non-JSON replies reject while HTTP errors preserve the bridge's message", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => new Response("<html>Proxy page</html>");
  await assert.rejects(bridgeRequest("tutor", {}), /Malformed bridge response/);
  globalThis.fetch = async () =>
    new Response("Synthetic service failure", { status: 503 });
  await assert.rejects(
    bridgeRequest("tutor", {}),
    /study bridge is not running/,
  );
  globalThis.fetch = async () =>
    new Response("Synthetic request refusal", { status: 400 });
  await assert.rejects(bridgeRequest("tutor", {}), /Synthetic request refusal/);
});

test("a streaming reply reports its text so far, then returns the answer", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  const status = () =>
    Response.json({
      mode: "claude-cli",
      label: "Fake",
      detail: "Fixture",
      capabilities: [],
    });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status") return status();
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      '{"text":"Wh"}\n{"text":"Why?"}\n{"answer":{"text":"Why?","complete":false}}\n',
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  }) as typeof fetch;
  try {
    await checkBridge();
    const seen: string[] = [];
    const answer = await bridgeRequest(
      "tutor",
      { requestId: "s" },
      {
        onText: (text) => seen.push(text),
      },
    );
    assert.deepEqual(seen, ["Wh", "Why?"]);
    assert.equal((answer as any).text, "Why?");
    assert.equal(bodies[0].stream, true);
    globalThis.fetch = (async () =>
      new Response('{"text":"Wh"}\n{"error":"Usage limit"}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      })) as typeof fetch;
    await assert.rejects(
      bridgeRequest("tutor", {}, { onText: () => {} }),
      /Usage limit/,
    );
  } finally {
    globalThis.fetch = (async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture ended",
        capabilities: [],
      })) as typeof fetch;
    await checkBridge();
    globalThis.fetch = original;
  }
});

test("a streamed reply tolerates blank lines and a missing final newline, rejects garbage and closes its stream", async () => {
  const original = globalThis.fetch;
  const online = () =>
    Response.json({
      mode: "claude-cli",
      label: "Fake",
      detail: "Fixture",
      capabilities: [],
    });
  const ndjson = { headers: { "Content-Type": "application/x-ndjson" } };
  let body = "";
  let cancelled = 0;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input) === "/api/status") return online();
    const bytes = new TextEncoder().encode(body);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          // Left open on purpose: only the reader can end this exchange.
        },
        cancel() {
          cancelled++;
        },
      }),
      ndjson,
    );
  }) as typeof fetch;
  try {
    await checkBridge();
    body = '\n{"text":"Wh"}\n\n{"answer":{"text":"Why?"}}\n{"text":"late"}\n';
    const seen: string[] = [];
    const answer = await bridgeRequest(
      "tutor",
      {},
      { onText: (text) => seen.push(text) },
    );
    assert.equal((answer as any).text, "Why?");
    assert.deepEqual(seen, ["Wh"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, 1, "the answered stream is released");
    body = '{"text":"Wh"}\nnot json\n';
    await assert.rejects(
      bridgeRequest("tutor", {}, { onText: () => {} }),
      /Malformed bridge response/,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, 2, "a failed stream is released too");
    globalThis.fetch = (async () =>
      new Response(
        '{"text":"Wh"}\n{"answer":{"text":"Done"}}',
        ndjson,
      )) as typeof fetch;
    assert.equal(
      ((await bridgeRequest("tutor", {}, { onText: () => {} })) as any).text,
      "Done",
    );
    // Progress is display only: a listener that throws cannot cost the answer.
    globalThis.fetch = (async () =>
      new Response(
        '{"text":"Wh"}\n{"answer":{"text":"Kept"}}\n',
        ndjson,
      )) as typeof fetch;
    assert.equal(
      (
        (await bridgeRequest(
          "tutor",
          {},
          {
            onText: () => {
              throw Error("repaint failed");
            },
          },
        )) as any
      ).text,
      "Kept",
    );
    globalThis.fetch = (async () =>
      new Response('{"text":"Wh"}\n', ndjson)) as typeof fetch;
    await assert.rejects(
      bridgeRequest("tutor", {}, { onText: () => {} }),
      /ended before its answer/,
    );
  } finally {
    globalThis.fetch = (async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture ended",
        capabilities: [],
      })) as typeof fetch;
    await checkBridge();
    globalThis.fetch = original;
  }
});

async function outcome(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail("the request was expected to fail");
}
const ndjson = { headers: { "Content-Type": "application/x-ndjson" } };

test("a request the way to the relay cut off is an interruption, one the owner or the relay decided is not", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  // The page reloads or the relay is unreachable: fetch itself fails.
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const lost = await outcome(() => bridgeRequest("tutor", {}));
  assert.ok(lost instanceof BridgeInterrupted);
  assert.equal(isInterruption(lost), true);

  // The owner's own cancel is a decision, not a cut line.
  const owner = new AbortController();
  globalThis.fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      owner.abort();
    });
  const cancelled = await outcome(() =>
    bridgeRequest("tutor", {}, { signal: owner.signal }),
  );
  assert.equal(isInterruption(cancelled), false);
  assert.equal((cancelled as Error).name, "AbortError");

  // The app server's own 502 while the relay restarts has no gateway code.
  globalThis.fetch = async () =>
    Response.json(
      { error: "Study bridge unavailable: connection refused" },
      { status: 502 },
    );
  assert.equal(
    isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
    true,
  );
  // A gateway failure also says 502 but names its code: it was refused.
  globalThis.fetch = async () =>
    Response.json(
      { error: "Study bridge unavailable: model refused", code: "refused" },
      { status: 502 },
    );
  const refused = await outcome(() => bridgeRequest("tutor", {}));
  assert.equal(isInterruption(refused), false);
  assert.match((refused as Error).message, /model refused/);
  // Any other 502 message is the relay's own answer too.
  globalThis.fetch = async () =>
    Response.json({ error: "Claude failed" }, { status: 502 });
  assert.equal(
    isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
    false,
  );
  // The relay answers 499 for a call whose caller went away.
  globalThis.fetch = async () =>
    Response.json({ error: "Caller went away" }, { status: 499 });
  assert.equal(
    isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
    true,
  );
  // Plain-text 502-504 from a proxy, and a refusal that is plain 400/500.
  for (const code of [502, 503, 504])
    ((globalThis.fetch = async () =>
      new Response("Bad gateway", { status: code })),
      assert.equal(
        isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
        true,
        `plain ${code}`,
      ));
  for (const code of [400, 500])
    ((globalThis.fetch = async () =>
      Response.json({ error: "No" }, { status: code })),
      assert.equal(
        isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
        false,
        `JSON ${code}`,
      ));
  // Ordinary errors are not interruptions.
  assert.equal(isInterruption(Error("x")), false);
  assert.equal(isInterruption("BridgeInterrupted"), false);
});

test("a body that breaks off while it is read is an interruption", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      }),
    );
  assert.equal(
    isInterruption(await outcome(() => bridgeRequest("tutor", {}))),
    true,
  );
});

test("a stream that ends without an answer or breaks mid-read is an interruption, a streamed error is not", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => new Response('{"text":"Wh"}\n', ndjson);
  const ended = await outcome(() =>
    bridgeRequest("tutor", {}, { onText: () => {} }),
  );
  assert.ok(isInterruption(ended));
  assert.match((ended as Error).message, /ended before its answer/);

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"text":"Wh"}\n'));
          controller.error(new TypeError("network error"));
        },
      }),
      ndjson,
    );
  assert.equal(
    isInterruption(
      await outcome(() => bridgeRequest("tutor", {}, { onText: () => {} })),
    ),
    true,
  );
  // An error the relay streamed is its decision.
  globalThis.fetch = async () =>
    new Response('{"error":"Usage limit"}\n', ndjson);
  assert.equal(
    isInterruption(
      await outcome(() => bridgeRequest("tutor", {}, { onText: () => {} })),
    ),
    false,
  );
});

test("an owner's cancel while the reply streams in is its decision, not a cut line", async (t) => {
  const original = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = (async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture ended",
        capabilities: [],
      })) as typeof fetch;
    await checkBridge();
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Fake",
        detail: "Fixture",
        capabilities: [],
      });
    // The body follows the request's signal, as a browser's does.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"Wh"}\n'));
        init!.signal!.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted", "AbortError")),
        );
      },
    });
    return new Response(body, ndjson);
  }) as typeof fetch;
  await checkBridge();
  const owner = new AbortController();
  const cancelled = await outcome(() =>
    bridgeRequest(
      "tutor",
      { requestId: "s" },
      { signal: owner.signal, onText: () => owner.abort() },
    ),
  );
  assert.equal(isInterruption(cancelled), false);
  assert.equal((cancelled as Error).name, "AbortError");
  // The same stream breaking off on its own is a cut line.
  const lost = new AbortController();
  globalThis.fetch = (async (input: unknown) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Fake",
        detail: "Fixture",
        capabilities: [],
      });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"Wh"}\n'));
        lost.signal.addEventListener("abort", () =>
          controller.error(new TypeError("network error")),
        );
      },
    });
    return new Response(body, ndjson);
  }) as typeof fetch;
  const broken = await outcome(() =>
    bridgeRequest("tutor", { requestId: "s" }, { onText: () => lost.abort() }),
  );
  assert.equal(isInterruption(broken), true);
});
