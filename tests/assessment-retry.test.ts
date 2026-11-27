import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assess, checkBridge, edit } from "../src/ai";
import { eligible, evidencePacket, initialStudy } from "../src/curriculum";
import { encounterKey } from "../src/learner";
import { resumableAssessments } from "../src/resume-work";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { watchStudyEvents } from "../src/study-events";
import { createRecord } from "./helpers/record";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const r = structuredClone(roadmap),
    g = createRecord(725, r);
  g.study = initialStudy(r, "live");
  const e = g.encounters["question-0"],
    contract = eligible(r, g.study);
  e.problem = {
    title: "Synthetic assessment lifecycle",
    prompt: "Transport fixture only",
    starter: "",
    rubric: [],
    provenance: "claude-cli",
    contract,
    scopeDefinitions: [
      {
        id: `${contract.objectiveIds[0]}/D${contract.depth}`,
        objectiveId: contract.objectiveIds[0],
        depth: contract.depth,
        sourceScope: contract.scopes[0],
        facets: [{ id: "scope", description: "Synthetic complete scope" }],
      },
    ],
  };
  edit(g, e, "Synthetic human reasoning", e.revision, r);
  return { g, e, r };
}
async function connection(handler: typeof fetch) {
  const original = globalThis.fetch;
  let mode = "claude-cli";
  globalThis.fetch = async (url, init) =>
    String(url) === "/api/status"
      ? Response.json({
          mode,
          capabilities: ["assess"],
          label: "Synthetic",
          detail: "Isolated transport fixture",
        })
      : handler(url, init);
  await checkBridge();
  return {
    async reconnect() {
      mode = "claude-cli";
      await checkBridge();
    },
    async disconnect() {
      mode = "development";
      await checkBridge();
    },
    async restore() {
      mode = "development";
      await checkBridge();
      globalThis.fetch = original;
    },
  };
}
const unresolved = () =>
  Response.json({ findings: [], visitOutcome: "unresolved" });

test("an offline assessment freezes the original partial work before reconnect and reload", async () => {
  const { g, e, r } = fixture(),
    bodies: string[] = [],
    settled: Record<string, unknown>[] = [];
  watchStudyEvents((type, data) => {
    if (type === "assessment-settled") settled.push(data);
  });
  const bridge = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    return unresolved();
  });
  try {
    await bridge.disconnect();
    await assess(g, e, r);
    const assessment = g.study.assessments[0],
      captured = assessment.request;
    assert.equal(assessment.status, "review-required");
    assert.equal(captured?.provider, "claude-cli");
    assert.ok(captured, "An offline attempt lost its frozen assessment packet");
    assert.equal(bodies.length, 0);
    const ledger = JSON.stringify(g.study.learner),
      restored = recover(decode(encode(g))),
      saved = restored.encounters[e.id];
    r.tracks[e.problem!.contract.track].progress += "\nLater source context";
    edit(
      restored,
      saved,
      "Later human answer outside this review",
      saved.revision,
      r,
    );
    await bridge.reconnect();
    await assess(restored, saved, r, assessment.evidenceCutoffSequence, true);
    assert.equal(bodies.length, 1);
    assert.equal(
      JSON.stringify(JSON.parse(bodies[0]).payload),
      captured.payloadJson,
    );
    assert.ok(!bodies[0].includes("Later human answer outside this review"));
    assert.ok(!bodies[0].includes("Later source context"));
    assert.equal(restored.study.assessments[0].status, "applied");
    assert.deepEqual(restored.study.learner!.evidence, []);
    assert.equal(g.study.learner && JSON.stringify(g.study.learner), ledger);
    // Diagnostics hear how each grading settled, by id and state only.
    assert.deepEqual(
      settled.map((s) => [s.assessment, s.status, s.retry]),
      [
        [assessment.id, "review-required", false],
        [assessment.id, "applied", true],
      ],
    );
  } finally {
    watchStudyEvents(undefined);
    await bridge.restore();
  }
});

test("a partial assessment packet cannot expose a later accepted answer beyond its cutoff", () => {
  const { e, g, r } = fixture(),
    cutoff = g.seq;
  edit(
    g,
    e,
    "Later answer that was not yet written at the cutoff",
    e.revision,
    r,
  );
  e.submissions.push({
    id: "synthetic-later-accepted",
    author: "human",
    revision: e.revision,
    content: e.workspace,
    seq: ++g.seq,
    status: "complete",
    feedback: "Synthetic completion only",
  });
  e.accepted = "synthetic-later-accepted";
  const packet = evidencePacket(e, r, cutoff, g.study.learner);
  assert.equal(packet.accepted, undefined);
  assert.ok(
    !JSON.stringify(packet).includes("Later answer that was not yet written"),
  );
  assert.equal(evidencePacket(e, r).accepted?.id, e.accepted);
});

test("an ordinary completed assessment retains the accepted submission event after its last artifact", async () => {
  const { e, g, r } = fixture(),
    artifactCutoff = g.seq,
    packets: ReturnType<typeof evidencePacket>[] = [];
  e.submissions.push({
    id: "synthetic-ordinary-accepted",
    author: "human",
    revision: e.revision,
    content: e.workspace,
    seq: ++g.seq,
    status: "complete",
    feedback: "Synthetic completion only",
  });
  e.accepted = "synthetic-ordinary-accepted";
  const bridge = await connection(async (_url, init) => {
    packets.push(JSON.parse(String(init?.body)).payload.packet);
    return unresolved();
  });
  try {
    await assess(g, e, r);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].accepted?.id, e.accepted);
    assert.equal(packets[0].evidenceCutoffSequence, artifactCutoff);
    assert.equal(
      g.study.assessments[0].id,
      `assessment-${g.id}/${e.id}-${artifactCutoff}`,
      "Existing artifact-based assessment IDs must remain stable",
    );
  } finally {
    await bridge.restore();
  }
});

test("assessment retries after reload reuse their exact captured packet despite later source context", async () => {
  const { g, e, r } = fixture(),
    bodies: string[] = [];
  const bridge = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? Response.json({ error: "Synthetic outage" }, { status: 503 })
      : unresolved();
  });
  try {
    await assess(g, e, r);
    assert.equal(g.study.assessments[0].status, "review-required");
    const restored = recover(decode(encode(g))),
      saved = restored.encounters[e.id];
    r.tracks[e.problem!.contract.track].progress +=
      "\nSynthetic source context changed after capture";
    edit(restored, saved, "Later unsent human reasoning", saved.revision, r);
    await assess(
      restored,
      saved,
      r,
      restored.study.assessments[0].evidenceCutoffSequence,
      true,
    );
    assert.equal(bodies.length, 2);
    assert.ok(bodies[1] === bodies[0], "Retry changed the captured packet");
    assert.equal(
      restored.study.assessments[0].status,
      "applied",
      restored.study.assessments[0].provenance,
    );
  } finally {
    await bridge.restore();
  }
});

test("a late assessment cannot apply after the original provider disconnects", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const before = JSON.stringify(g.study.learner),
      pending = assess(g, e, r);
    await bridge.disconnect();
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.match(g.study.assessments[0].provenance, /provider.*changed/i);
    assert.equal(JSON.stringify(g.study.learner), before);
  } finally {
    await bridge.restore();
  }
});

test("a late assessment cannot mutate a replacement learner ledger", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const pending = assess(g, e, r);
    g.study.learner = structuredClone(g.study.learner!);
    const replacement = JSON.stringify(g.study.learner);
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.equal(JSON.stringify(g.study.learner), replacement);
  } finally {
    await bridge.restore();
  }
});

test("late archived assessment still applies to the retained shared study state", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const pending = assess(g, e, r);
    g.study.archives.push(e);
    const next = createRecord(726, r, g.study);
    finish(unresolved());
    await pending;
    assert.equal(next.study, g.study);
    assert.equal(next.study.assessments[0].status, "applied");
    assert.ok(next.study.learner!.receipts[next.study.assessments[0].id]);
  } finally {
    await bridge.restore();
  }
});

test("a changed task cannot receive the late assessment of its previous question", async () => {
  const { g, e, r } = fixture();
  let finish!: (response: Response) => void;
  const bridge = await connection(
    async () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  try {
    const before = JSON.stringify(g.study.learner),
      pending = assess(g, e, r);
    e.problem!.prompt = "A different synthetic question";
    finish(unresolved());
    await pending;
    assert.equal(g.study.assessments[0].status, "review-required");
    assert.match(g.study.assessments[0].provenance, /captured task/);
    assert.equal(JSON.stringify(g.study.learner), before);
  } finally {
    await bridge.restore();
  }
});

test("long retained histories can capture their cutoff without overflowing the argument stack", async () => {
  const { g, e, r } = fixture();
  const bridge = await connection(async () => unresolved());
  try {
    await bridge.disconnect();
    e.history = Array.from({ length: 150_000 }, (_, i) => ({
      seq: i + 1,
      author: "human",
      kind: "defense" as const,
      text: "Synthetic retained defense observation",
      at: i,
      revision: 0,
    }));
    await assess(g, e, r);
    assert.equal(g.study.assessments[0].evidenceCutoffSequence, 150_000);
    assert.equal(g.study.assessments[0].status, "review-required");
  } finally {
    await bridge.restore();
  }
});

test("an assessment cut off by a lost relay is marked to be sent again, and a refused one is not", async () => {
  const { g, e, r } = fixture();
  let mode: "lost" | "refused" | "ok" = "lost";
  const bridge = await connection(async () => {
    if (mode === "lost") throw new TypeError("Failed to fetch");
    if (mode === "refused")
      return Response.json({ error: "Synthetic refusal" }, { status: 400 });
    return unresolved();
  });
  try {
    await assess(g, e, r);
    const a = g.study.assessments[0];
    assert.equal(a.status, "review-required");
    assert.match(a.provenance, /relay was lost|Assessment unresolved/);
    assert.equal(a.resume, true);
    assert.deepEqual(
      resumableAssessments(g).map((x) => x.assessment.id),
      [a.id],
    );
    // The retry itself starts by forgetting the old verdict, then is refused.
    mode = "refused";
    await assess(g, e, r, a.evidenceCutoffSequence, true);
    assert.equal(a.status, "review-required");
    assert.equal(a.resume, false);
    assert.deepEqual(resumableAssessments(g), []);
    // Cut off again, then settled.
    mode = "lost";
    await assess(g, e, r, a.evidenceCutoffSequence, true);
    assert.equal(a.resume, true);
    mode = "ok";
    await assess(g, e, r, a.evidenceCutoffSequence, true);
    assert.equal(a.status, "applied");
    assert.equal(a.resume, undefined);
    assert.deepEqual(resumableAssessments(g), []);
  } finally {
    await bridge.restore();
  }
});

test("an assessment waiting only for its connection is marked to be sent again and clears the mark when it starts", async () => {
  const { g, e, r } = fixture(),
    bodies: string[] = [];
  const bridge = await connection(async (_url, init) => {
    bodies.push(String(init?.body));
    return unresolved();
  });
  try {
    await bridge.disconnect();
    await assess(g, e, r);
    const a = g.study.assessments[0];
    assert.equal(a.status, "review-required");
    assert.equal(a.resume, true);
    // It survives a reload and is still found.
    const restored = recover(decode(encode(g)));
    assert.deepEqual(
      resumableAssessments(restored).map((x) => x.assessment.id),
      [a.id],
    );
    await bridge.reconnect();
    const found = resumableAssessments(restored)[0];
    await assess(
      restored,
      found.encounter,
      r,
      found.assessment.evidenceCutoffSequence,
      true,
    );
    assert.equal(bodies.length, 1);
    assert.equal(restored.study.assessments[0].status, "applied");
    assert.equal(restored.study.assessments[0].resume, undefined);
  } finally {
    await bridge.restore();
  }
});

test("an assessment loading found pending, or an earlier build left unresolved by a lost fetch, is still resumable", async () => {
  const { g, e, r } = fixture();
  const bridge = await connection(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    await assess(g, e, r);
    const a = g.study.assessments[0];
    // An earlier build wrote no resume mark.
    delete a.resume;
    a.provenance = "Assessment unresolved: TypeError: Failed to fetch";
    assert.deepEqual(
      resumableAssessments(g).map((x) => x.assessment.id),
      [a.id],
    );
    a.status = "pending";
    const restored = recover(decode(encode(g)));
    assert.match(
      restored.study.assessments[0].provenance,
      /Application restarted during assessment/,
    );
    assert.deepEqual(
      resumableAssessments(restored).map((x) => x.assessment.id),
      [a.id],
    );
  } finally {
    await bridge.restore();
  }
});

test("a retried older cutoff reports its own assessment to diagnostics", async () => {
  const { g, e, r } = fixture(),
    settled: Record<string, unknown>[] = [];
  watchStudyEvents((type, data) => {
    if (type === "assessment-settled") settled.push(data);
  });
  try {
    // Offline: each cutoff is captured and left for retry.
    await assess(g, e, r);
    edit(g, e, "A later synthetic answer", e.revision, r);
    await assess(g, e, r);
    const [older, newer] = g.study.assessments;
    assert.notEqual(older.id, newer.id);
    settled.length = 0;
    await assess(g, e, r, older.evidenceCutoffSequence, true);
    assert.deepEqual(
      settled.map((s) => [s.assessment, s.status, s.retry]),
      [[older.id, "review-required", true]],
    );
  } finally {
    watchStudyEvents(undefined);
  }
});

test("a malformed externally resolved attempt settles for review instead of staying pending", async () => {
  const { g, e, r } = fixture();
  g.study.learner!.attempts.push({
    id: "S0099-A1",
    session: "S0099",
    encounter: encounterKey(e),
    contract: structuredClone(e.problem!.contract),
    status: "externally-resolved",
    startedAt: "2026-10-15T16:00:00.000Z",
  });
  await assess(g, e, r);
  const a = g.study.assessments[0];
  assert.equal(a.status, "review-required");
  assert.match(a.provenance, /Assessment unresolved/);
});
