import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, retryTutorRequest, send } from "../src/ai";
import { initialStudy } from "../src/curriculum";
import { encounterKey } from "../src/learner";
import type {
  Assessment,
  Encounter,
  Roadmap,
  StudyRecord,
  TutorRequest,
} from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  resumableAssessments,
  resumableTutorRequest,
} from "../src/resume-work";
import { preparePracticeRooms } from "./helpers/practice-questions";
import { createRecord } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const RESTARTED_ASSESSMENT =
  "Application restarted during assessment. Evidence cutoff and request identity retained for retry.";
const RESTARTED_TUTOR =
  "Application restarted; retry the exact saved private question.";

function liveRecord() {
  const g = createRecord(1, r);
  g.study = initialStudy(r, "live");
  return g;
}
function assessment(
  g: StudyRecord,
  over: Partial<Assessment> = {},
  question = "question-0",
): Assessment {
  const e = g.encounters[question];
  const a: Assessment = {
    id: `assessment-${encounterKey(e)}-${g.study.assessments.length + 1}`,
    encounter: e.id,
    sourceVersion: 0,
    findings: [],
    status: "review-required",
    provenance: "Live assessment connection unavailable; retained for retry.",
    request: { provider: "claude-cli", payloadJson: "{}" },
    ...over,
  };
  g.study.assessments.push(a);
  return a;
}
const picked = (g: StudyRecord) =>
  resumableAssessments(g).map((x) => x.assessment.id);

test("resumableAssessments picks cut-off work flagged by this build", () => {
  const g = liveRecord();
  const cut = assessment(g, { resume: true, provenance: "anything" });
  const refused = assessment(g, {
    resume: false,
    provenance: "Application restarted during assessment.",
  });
  assert.deepEqual(picked(g), [cut.id]);
  assert.equal(
    resumableAssessments(g)[0].encounter,
    g.encounters["question-0"],
  );
  assert.ok(refused);
});

test("resumableAssessments reads the notes loading and earlier builds wrote when resume is absent", () => {
  const g = liveRecord();
  const restarted = assessment(g, { provenance: RESTARTED_ASSESSMENT });
  const unreachable = assessment(g, {
    provenance:
      "Live assessment connection unavailable; work and request identity retained for retry.",
  });
  const fetchFailed = assessment(g, {
    provenance: "Assessment unresolved: TypeError: Failed to fetch",
  });
  const notRunning = assessment(g, {
    provenance:
      "Assessment unresolved: Error: The study bridge is not running. It is restarting",
  });
  const refusedText = assessment(g, {
    provenance: "Assessment unresolved: Error: Usage limit reached",
  });
  const unrelated = assessment(g, { provenance: "claude-cli" });
  assert.deepEqual(picked(g), [
    restarted.id,
    unreachable.id,
    fetchFailed.id,
    notRunning.id,
  ]);
  assert.ok(refusedText && unrelated);
});

test("resumableAssessments never picks applied, refused, pending, non-Claude or orphaned work", () => {
  const g = liveRecord();
  assessment(g, { resume: true, status: "applied" });
  assessment(g, { resume: true, status: "pending" });
  assessment(g, { resume: false });
  assessment(g, {
    resume: true,
    request: { provider: "development" as never, payloadJson: "{}" },
  });
  assessment(g, { resume: true, request: undefined });
  // Its question is gone, or the id belongs to another question.
  assessment(g, { resume: true, encounter: "question-99" });
  assessment(g, { resume: true, id: "assessment-other/question-0-1" });
  assert.deepEqual(picked(g), []);
  // Only a live study is resumed.
  const cut = assessment(g, { resume: true });
  assert.deepEqual(picked(g), [cut.id]);
  g.study.profile = "development";
  assert.deepEqual(picked(g), []);
});

test("resumableAssessments finds the question of an archived run too", () => {
  const g = liveRecord();
  const e = g.encounters["question-3"];
  g.study.archives.push(e);
  delete g.encounters["question-3"];
  const a = assessment(
    { ...g, encounters: { ...g.encounters, "question-3": e } } as StudyRecord,
    { resume: true },
    "question-3",
  );
  assert.deepEqual(
    resumableAssessments(g).map((x) => [x.assessment.id, x.encounter]),
    [[a.id, e]],
  );
});

function tutorEncounter(
  over: Partial<TutorRequest> = {},
  tail: Encounter["tutor"] = [],
) {
  const g = createRecord(2, r);
  const e = g.encounters["question-0"];
  e.tutor = [
    {
      id: "m1",
      author: "human",
      kind: "human",
      text: "My answer",
      seq: 5,
      worldTime: 0,
      provenance: "live-human",
    },
    ...tail,
  ];
  e.tutorRequests = [
    {
      id: "tutor-1",
      provider: "claude-cli",
      payloadJson: "{}",
      questionSequence: 5,
      state: "interrupted",
      ...over,
    },
  ];
  return e;
}
const said = (seq: number, kind: "human" | "tutor" = "human") => ({
  id: `m${seq}`,
  author: kind,
  kind,
  text: "More",
  seq,
  worldTime: 0,
  provenance: "live-human",
});

test("resumableTutorRequest returns the last cut-off job whose learner message is still the last", () => {
  const flagged = tutorEncounter({ resume: true });
  assert.equal(resumableTutorRequest(flagged), flagged.tutorRequests![0]);
  const restarted = tutorEncounter({ error: RESTARTED_TUTOR });
  assert.equal(resumableTutorRequest(restarted), restarted.tutorRequests![0]);
  // An explicit flag wins over the restart note.
  assert.equal(
    resumableTutorRequest(
      tutorEncounter({ error: RESTARTED_TUTOR, resume: false }),
    ),
    undefined,
  );
});

test("resumableTutorRequest declines refused, answered, resent, foreign and superseded work", () => {
  assert.equal(
    resumableTutorRequest(tutorEncounter({ resume: false })),
    undefined,
  );
  // Nothing says it was cut off.
  assert.equal(
    resumableTutorRequest(tutorEncounter({ error: "outage" })),
    undefined,
  );
  assert.equal(resumableTutorRequest(tutorEncounter({})), undefined);
  // An earlier build already resent the restart note once.
  assert.equal(
    resumableTutorRequest(
      tutorEncounter({ error: RESTARTED_TUTOR, resent: true }),
    ),
    undefined,
  );
  // Not interrupted, or not Claude.
  for (const state of ["pending", "applied", "superseded"] as const)
    assert.equal(
      resumableTutorRequest(tutorEncounter({ resume: true, state })),
      undefined,
    );
  assert.equal(
    resumableTutorRequest(
      tutorEncounter({ resume: true, provider: "development" as never }),
    ),
    undefined,
  );
  // The learner said something after it, or the tutor answered.
  assert.equal(
    resumableTutorRequest(tutorEncounter({ resume: true }, [said(6)])),
    undefined,
  );
  assert.equal(
    resumableTutorRequest(tutorEncounter({ resume: true }, [said(6, "tutor")])),
    undefined,
  );
  // The last message is not the one the job carries.
  assert.equal(
    resumableTutorRequest(
      tutorEncounter({ resume: true, questionSequence: 4 }),
    ),
    undefined,
  );
  // Only the last job counts.
  const e = tutorEncounter({ resume: true });
  e.tutorRequests!.push({
    ...e.tutorRequests![0],
    id: "tutor-2",
    resume: false,
  });
  assert.equal(resumableTutorRequest(e), undefined);
  e.tutorRequests = [];
  assert.equal(resumableTutorRequest(e), undefined);
  delete e.tutorRequests;
  assert.equal(resumableTutorRequest(e), undefined);
});

test("a record cut off mid-tutor-request is resumed after reload with the same payload and no second learner message", async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  let connected = true;
  let respond: (p: any) => Promise<Response> = () => new Promise(() => {});
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    const p = JSON.parse(String(init?.body));
    calls.push(p);
    return respond(p);
  }) as typeof fetch;
  try {
    await checkBridge();
    const g = createRecord(717, r);
    preparePracticeRooms(g, r);
    const e = g.encounters["question-0"];
    e.mode = "solo";
    e.owner = "human";
    // The reply never comes: the page is closed while it is awaited.
    void send(g, e, "My answer", r);
    for (let i = 0; i < 50 && calls.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(e.tutorRequests![0].state, "pending");
    const loaded = recover(decode(encode(g)));
    const saved = loaded.encounters[e.id];
    const job = resumableTutorRequest(saved);
    assert.ok(job, "the cut-off request is resumable after loading");
    assert.equal(job.state, "interrupted");
    const humans = () => saved.tutor.filter((m) => m.kind === "human").length;
    assert.equal(humans(), 1);
    respond = async () =>
      Response.json({ text: "What changes?", complete: false });
    await retryTutorRequest(loaded, saved, job.id, r);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].payload, calls[0].payload);
    assert.equal(humans(), 1, "the learner's message is not duplicated");
    assert.equal(saved.tutorRequests![0].state, "applied");
    assert.equal(saved.tutorRequests![0].resume, undefined);
    assert.equal(resumableTutorRequest(saved), undefined);
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
});

test("a resumed request saved before help policies ignores malformed help and still settles", async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  let connected = true;
  let respond: () => Promise<Response> = () => new Promise(() => {});
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    calls.push(JSON.parse(String(init?.body)));
    return respond();
  }) as typeof fetch;
  try {
    await checkBridge();
    const g = createRecord(718, r);
    preparePracticeRooms(g, r);
    const e = g.encounters["question-0"];
    e.mode = "solo";
    e.owner = "human";
    void send(g, e, "My answer", r);
    for (let i = 0; i < 50 && calls.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const loaded = recover(decode(encode(g)));
    const saved = loaded.encounters[e.id];
    const job = resumableTutorRequest(saved)!;
    // Requests saved before help policies existed carry none, so the help
    // gate never checks the declaration's shape.
    const payload = JSON.parse(job.payloadJson);
    delete payload.helpPolicy;
    job.payloadJson = JSON.stringify(payload);
    respond = async () =>
      Response.json({
        text: "What changes?",
        complete: false,
        help: { nudges: ["a"] },
      });
    await retryTutorRequest(loaded, saved, job.id, r);
    assert.equal(job.state, "applied");
    assert.equal(job.error, undefined);
    const reply = saved.tutor.at(-1)!;
    assert.equal(reply.kind, "tutor");
    assert.equal(reply.text, "What changes?");
    assert.equal(reply.help, undefined);
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
});
