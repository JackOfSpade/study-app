import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Direct .mjs contract test.
import { taskInstructions, validateAnswer } from "../scripts/lib/ai-contracts.mjs"; // prettier-ignore
import { PART_SOLVE_SECONDS_MAX } from "../scripts/lib/question-parts.mjs";
import { checkBridge, ensureProblem, regenerateQuestion } from "../src/ai";
import { eligible, initialStudy } from "../src/curriculum";
import {
  PROBE_STANCE,
  TERMINAL_DIALOGUE_INSTRUCTION,
} from "../src/knowledge-probe";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createRecord } from "./helpers/record";
import {
  MINIMUM_EVIDENCE_GUIDANCE,
  QUESTION_DESIGN_GUIDANCE,
  QUESTION_SHAPE_GUIDANCE,
  QUESTION_ADAPTATION_GUIDANCE,
  ASSESSMENT_HELP_GUIDANCE,
} from "../scripts/lib/study-question-policy.mjs";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const minimalPolicy = [
  /smallest self-contained diagnostic that exercises the objective/,
  /one main problem, and a follow-up only when it tests something the main problem does not/,
  /actual code under review, including any required helper and its authorization semantics/,
  /prose proposal supports design review only/,
  /short snippets, traces or evidence/,
  /never turn (an objective's )?scope verbs into a D1 implementation task/,
  /visible task and rubric must match,? without leaking the solution/,
  /honestly integrative objective may stay integrative on a small feature/,
  /narrow example never establishes unrelated facets or mastery/,
];

// Synthetic transport fixture: proves the policy reaches the provider, not AI quality.
function fixtureFetch(sent: any[]) {
  return (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Isolated question design fixture",
        capabilities: ["generate", "tutor", "assess"],
        detail: "Test fixture only; not a native Study Mode verification.",
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operation, "generate");
    sent.push(structuredClone(body.payload));
    const c = body.payload.contract;
    return Response.json({
      title: "Fixture question",
      prompt: "Isolated pipeline fixture.",
      starter: "",
      rubric: ["scope"],
      contract: c,
      scopeDefinitions: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          objectiveId: c.objectiveIds[0],
          depth: c.depth,
          sourceScope: c.scopes[0],
          facets: [{ id: "scope", description: "Complete scope fixture" }],
        },
      ],
    });
  }) as typeof fetch;
}

test("live generation payload carries the minimal concrete problem policy and keeps prior policy", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    assert.equal(e.problem?.provenance, "claude-cli");
    const policy: string = sent[0].generationPolicy;
    // Each rule travels once: the design guidance is in the instructions only.
    assert.ok(!policy.includes(QUESTION_DESIGN_GUIDANCE));
    for (const requirement of minimalPolicy) assert.match(policy, requirement);
    // Earlier policy remains intact; refinements are appended.
    assert.match(
      policy,
      /prompt and the part on screen together must supply.*without using the chat/,
    );
    assert.match(
      policy,
      /existing stable scope definitions are copied exactly/,
    );
    assert.match(policy, /Use probeRecords/);
    assert.match(
      policy,
      /Do not interpret an objective's implementation verb as a D1 implementation requirement/,
    );
    assert.equal(sent[0].contract.track, eligible(r, g.study).track);
    assert.deepEqual(
      e.problem?.contract.objectiveIds,
      sent[0].contract.objectiveIds,
    );
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a saved generation retries with its exact captured payload and request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    const captured = {
      requestId: "gen-synthetic-saved",
      encounterId: e.id,
      // JSON round trip: the transport drops undefined optional fields.
      contract: JSON.parse(JSON.stringify(eligible(r, g.study))),
      generationPolicy: "Synthetic earlier captured policy text.",
    };
    e.pendingGeneration = {
      provider: "claude-cli",
      requestId: "gen-synthetic-saved",
      payload: structuredClone(captured),
    };
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], captured);
    // The old captured policy is resent verbatim, never upgraded.
    assert.doesNotMatch(sent[0].generationPolicy, /smallest self-contained/);
    assert.equal(e.pendingGeneration, undefined);
    assert.equal(e.problem?.title, "Fixture question");
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("generate instructions require minimal concrete problems with unchanged contracts", () => {
  const contract = {
    id: "synthetic-review",
    objectiveIds: ["SYNTHETIC:REVIEW"],
    scopes: ["Review an authorization change."],
    depth: 2,
  };
  const job = {
    instructions: taskInstructions("generate", {
      requestId: "synthetic-minimal",
      contract,
    }) as string,
  };
  assert.ok(job.instructions.includes(QUESTION_DESIGN_GUIDANCE));
  for (const requirement of minimalPolicy)
    assert.match(job.instructions, requirement);
  assert.match(job.instructions, /Copy the exact eligible contract/);
  assert.match(
    job.instructions,
    /existing stable scope definitions are copied exactly, never rewritten/,
  );
  assert.match(
    job.instructions,
    /prompt together with the part on screen, must stand on its own/,
  );
  assert.doesNotMatch(job.instructions, /establishes the most at once/);
});

test("the relay accepts a contract copy that keeps what the app checks, and names what differs", () => {
  const contract = {
    kind: "checkpoint",
    id: "live-3-PY:T11.1/D1",
    track: "PY",
    objectiveIds: ["PY:T11.1"],
    scopes: ["A long scope sentence the model may retype."],
    depth: 1,
    phase: "REPAIR_VERIFY",
    review: false,
    ledgerVersion: 3,
    priorEvidence: ["A long evidence reference."],
    preservedFacets: [],
    missingFacets: ["a", "b"],
    scheduleNote: "Synthetic note",
  };
  const job = { operation: "generate", payload: { contract } };
  const reply = (copy: unknown) => ({
    title: "Support ticket queue",
    prompt: "Shared facts.",
    starter: "",
    rubric: ["Names the cost."],
    contract: copy,
    scopeDefinitions: [{ id: "s" }],
    partSolveSeconds: [60],
  });
  validateAnswer(job, reply(contract));
  // The slips that cost a second generation on 2026-11-20: an optional key
  // left out, a long string retyped, keys in another order.
  const { missingFacets: _m, scheduleNote: _s, kind: _k, ...lean } = contract;
  validateAnswer(job, reply(lean));
  validateAnswer(job, reply({ ...contract, scopes: ["Retyped scope."] }));
  validateAnswer(
    job,
    reply(Object.fromEntries(Object.entries(contract).reverse())),
  );
  // What the app refuses is still refused here, and the correction says where.
  for (const [field, value] of [
    ["track", "PE"],
    ["depth", 2],
    ["objectiveIds", ["PY:T11.2"]],
    ["ledgerVersion", 4],
    ["review", true],
    ["kind", "transfer"],
    ["phase", "LEARN"],
  ] as const)
    assert.throws(
      () => validateAnswer(job, reply({ ...contract, [field]: value })),
      new RegExp(`Copy the exact eligible contract.*\\(${field} differs`),
      field,
    );
  assert.throws(
    () => validateAnswer(job, reply(undefined)),
    /contract differs/,
  );
  assert.throws(() => validateAnswer(job, reply("PY")), /contract differs/);
});

test("a question has no total time limit, but each part does", () => {
  const contract = { id: "synthetic-sitting", depth: 2 };
  const job = { operation: "generate", payload: { contract } };
  const answer = (estimatedSolveSeconds: number, partSolveSeconds = [60]) => ({
    title: "Late deliveries report",
    prompt: "Explain the bug.",
    starter: "",
    rubric: ["Names the race."],
    contract,
    scopeDefinitions: [{ id: "s" }],
    estimatedSolveSeconds,
    partSolveSeconds,
  });
  // A long problem is fine: it is worked in short parts.
  const long = {
    ...answer(3600, Array(12).fill(PART_SOLVE_SECONDS_MAX)),
    parts: Array(12).fill("ask"),
  };
  assert.doesNotThrow(() => validateAnswer(job, long));
  assert.throws(() => validateAnswer(job, answer(29)), /at least 30/);
  // A short part is never worth a second generation.
  assert.doesNotThrow(() => validateAnswer(job, answer(60, [10])));
  // The number of parts has no limit.
  const parts = (n: number) => ({
    ...answer(60, Array(n).fill(60)),
    parts: Array(n).fill("ask"),
  });
  assert.doesNotThrow(() => validateAnswer(job, parts(12)));
  assert.throws(() => validateAnswer(job, parts(0)), /one or more nonempty/);
  // A part over the limit is sent back to be split into steps, and so is a
  // missing or miscounted list, but never refused on the last try.
  const over = {
    ...answer(1200, [60, 601]),
    parts: ["Pick one.", "Build it."],
  };
  assert.throws(
    () => validateAnswer(job, over),
    /parts\[1\] is estimated at 601 seconds.*cut any ask in it the skill does not need.*split what remains into consecutive steps.*one function, method or distinct piece of behaviour per part/,
  );
  assert.doesNotThrow(() => validateAnswer(job, over, { final: true }));
  const miscounted = { ...answer(120, [60]), parts: ["Pick one.", "Why?"] };
  assert.throws(
    () => validateAnswer(job, miscounted),
    /partSolveSeconds, an array of 2 numbers/,
  );
  // A zero or negative estimate is malformed, not short.
  for (const bad of [[0], [-5]])
    assert.throws(
      () => validateAnswer(job, answer(60, bad)),
      /Return partSolveSeconds/,
    );
  const { partSolveSeconds: _, ...missing } = answer(60);
  assert.throws(() => validateAnswer(job, missing), /Return partSolveSeconds/);
  assert.doesNotThrow(() => validateAnswer(job, missing, { final: true }));
  // A part with two requests is sent back once, never refused on the last try.
  const two = { ...answer(60), parts: ["Which would you use? Give its cost."] };
  assert.throws(() => validateAnswer(job, two), /more than one thing/);
  assert.doesNotThrow(() => validateAnswer(job, two, { final: true }));
  // Both reasons go in the one correction.
  assert.throws(
    () => validateAnswer(job, { ...two, partSolveSeconds: [900] }),
    /more than one thing.*parts\[0\] is estimated at 900 seconds/s,
  );
  const instructions = taskInstructions("generate", { contract }) as string;
  assert.doesNotMatch(instructions, /15 minutes|one sitting/);
  assert.match(instructions, /The whole question has no time limit/);
  assert.match(instructions, /at most 10 minutes each/);
  assert.match(
    instructions,
    /a long implementation is built over several parts, one function, method or distinct piece of behaviour per part/,
  );
  assert.match(instructions, /states that result in one short line/);
  assert.match(instructions, /continue with the approach they chose/);
  assert.match(
    instructions,
    /states that result in one short line before its ask, as the starting point/,
  );
  assert.match(
    instructions,
    /The consecutive steps of a problem too long for one part are not extra asks/,
  );
  // A real question on 2026-11-28 asked which test kind would catch a bug, and
  // why, before asking why the existing tests missed it: the second part was
  // the first part's reason, asked again in the wrong order.
  assert.match(
    instructions,
    /a diagnosis comes before the remedy it supports \(why the existing tests missed a bug, then which kind of test would catch it\)/,
  );
  assert.match(
    instructions,
    /if an earlier part's 'and why' would already state a later part's answer, cut one of the two/,
  );
  // The regenerated question on 2026-11-28 asked whether a regression test
  // "would have failed before the release" that introduced the bug.
  assert.match(
    instructions,
    /answer each part yourself, as the learner would, from prompt and that part alone, and make sure its words ask for the answer the rubric expects/,
  );
  // The 2026-11-28 generate quality loop (round 1, 2 of 12 passed): rubric
  // lines required a remedy, a rejected alternative or a rebuttal the ask never
  // named, and prompts or asks gave the tested insight away.
  assert.match(
    instructions,
    /Check each line against the shortest complete correct answer to its ask as worded, and against a second correct answer that takes another route \(another construct, grouping or qualifying property\); both must satisfy it: a line for a diagnosis never also requires the remedy/,
  );
  assert.match(
    instructions,
    /a distractor is a claim that must not appear, never a statement the answer must make/,
  );
  assert.match(
    instructions,
    /A verdict and its reason are one judgement; a remedy, a comparison or a further consequence is another/,
  );
  assert.match(
    instructions,
    /A value a line requires follows from the stated facts, or the ask names it as the learner's choice to justify/,
  );
  assert.match(
    instructions,
    /the prompt states facts, never the definition, rule or insight a rubric line checks/,
  );
  assert.match(
    instructions,
    /a later part never presumes an earlier part's verdict \('the same kind of problem'\)/,
  );
  assert.match(
    instructions,
    /Ask for a superlative \('worst', 'most important'\) only when the rubric checks one defensible answer/,
  );
  assert.match(instructions, /material no part asks about is never kept/);
  // The 2026-11-28 generate quality loop, round 2 (5 of 12 passed): open asks
  // whose rubric accepted one of several correct answers, qualities ('smallest',
  // 'for any input') the ask never named, the same point credited in two parts,
  // label definitions that turned a sort into a lookup, and 'name two'.
  assert.match(
    instructions,
    /When the facts support more than one correct answer to an open ask \('what cost does this add', 'why is a passing test not enough'\), the line accepts any of them, worded with 'such as', or the ask names the subject the line checks/,
  );
  assert.match(
    instructions,
    /such as specific figures, a named caveat, a format, a length, a granularity \('one behaviour per pull request'\), 'smallest', 'for any input', grounding in a named fact, a quality the reason must have/,
  );
  assert.match(
    instructions,
    /a line for an ask to list what a requirement calls for never requires an item the requirement does not state/,
  );
  assert.match(
    instructions,
    /No two lines credit the same point: what an earlier part's line requires is never required again by a later one/,
  );
  assert.match(
    instructions,
    /a prompt that defines each label the learner sorts cases into, in the words of the reasons the rubric expects, turns the sort into a lookup/,
  );
  assert.match(
    instructions,
    /Never ask for a count of items of one kind \('name two assumptions', 'give three risks'\) when one shows the same skill/,
  );
  // Round 3 (6 of 12 passed): a 'such as' example that only half fixed the
  // problem, two alternative findings joined by 'and', one required reason when
  // others were correct, a required step of a kind the ask never named, and
  // give-aways through a team guideline, a premise or category vocabulary.
  assert.match(
    instructions,
    /each 'such as' example is itself a complete correct answer to the ask, never a partial fix/,
  );
  assert.match(
    instructions,
    /a line never joins with 'and' two findings either of which answers the ask, so an ask for one property, reason or difference accepts any one the facts support, worded with 'such as'; and a reason the line requires is any reason the facts support unless the ask names one/,
  );
  assert.match(
    instructions,
    /a line for an ask that names one kind of item \('the files and functions it passes through'\) never requires an item of another kind/,
  );
  assert.match(
    instructions,
    /a team guideline, a requirement or a part's premise that states the rule or the reason being tested/,
  );
  assert.match(
    instructions,
    /an item described in the words of the category or answer it is to be matched to: describe items by behaviour/,
  );
  assert.match(
    instructions,
    /a premise a part adds keeps in play what the part tests/,
  );
  // Round 4 (6 of 12 passed): a line banning `any` where correct answers use
  // it, a granularity the ask never named, several properties joined for an
  // ask for one, a reason for an error that is no longer shown, asks naming
  // the kind of answer or saying the items differ, and a prompt that
  // previewed the parts' asks.
  assert.match(
    instructions,
    /and against a second correct answer that takes another route \(another construct, grouping or qualifying property\); both must satisfy it/,
  );
  assert.match(
    instructions,
    /never bans a construct, keyword or technique the ask does not rule out/,
  );
  assert.match(
    instructions,
    /a granularity \('one behaviour per pull request'\)/,
  );
  assert.match(
    instructions,
    /an ask for one property, reason or difference accepts any one the facts support, worded with 'such as'/,
  );
  assert.match(
    instructions,
    /a line for why something is shown never requires why something else is not/,
  );
  assert.match(
    instructions,
    /names the kind of answer being tested \('replace it with the native element'/,
  );
  assert.match(
    instructions,
    /hints how many cases or kinds there are or that they differ \('as three different kinds'\)/,
  );
  assert.match(
    instructions,
    /the prompt never previews, lists or defines what the parts will ask for/,
  );
  // Round 5 (6 of 12 passed): lines still required elements the ask never
  // named (test build details, segment properties, coverage of named cases,
  // a reason's quality), an ask claimed one missing piece where the facts
  // left two, a trace left out the click that focused the input, a 'such as'
  // fix broke a stated requirement, and a prompt defined the term tested.
  assert.match(
    instructions,
    /to check, quote for each element a line requires the words of its ask that request it, and cut from the line, or name in the ask, every element that has none/,
  );
  assert.match(
    instructions,
    /a quality the reason must have \('grounded in a constraint, not a preference'\), properties each item must carry or coverage of named cases/,
  );
  assert.match(
    instructions,
    /never also requires how it is built \(a test's setup, forced inputs or assertions\)/,
  );
  assert.match(
    instructions,
    /or a change that breaks another requirement the prompt or part states/,
  );
  assert.match(
    instructions,
    /An ask that says the material holds exactly one of something \('the one piece the plan leaves out', 'the bug'\) must be true of the facts/,
  );
  assert.match(
    instructions,
    /the facts state every action from the start that produces output, including how an element got focus or state/,
  );
  assert.match(
    instructions,
    /nor a definition of the term the question is about, which it uses bare because grasping it is what is tested/,
  );
  assert.match(
    instructions,
    /or lists what to cover \('describe it: what \.\.\., which \.\.\. and why \.\.\.'\), it is several asks/,
  );
  assert.match(
    taskInstructions("assess", { contract }) as string,
    /a result that a later part states is never help for an answer given in an earlier part/,
  );
  const tutor = taskInstructions("tutor", {
    contract,
    stage: { part: 1, of: 2, question: "Pick one." },
  }) as string;
  assert.match(
    tutor,
    /answered correctly and accepted \(later parts build on this one/,
  );
  assert.match(
    tutor,
    /name in one sentence a reasonable choice or the correct result/,
  );
  for (const op of ["generate", "tutor", "assess"])
    assert.doesNotMatch(
      taskInstructions(op, { contract }) as string,
      /segment/i,
      `${op} still mentions segments`,
    );
});

test("tutor instructions use focused questioning without breadth inflation", () => {
  const job = {
    instructions: taskInstructions("tutor", {
      requestId: "synthetic-tutor",
      problem: { prompt: "Synthetic task; never real learner proof" },
      messages: [{ text: "PRIVATE_SYNTHETIC_TUTOR_CONTEXT" }],
    }) as string,
  };
  assert.ok(job.instructions.includes(QUESTION_ADAPTATION_GUIDANCE));
  assert.match(job.instructions, /one rung per miss on the same point/);
  assert.match(job.instructions, /never give one before that warning/);
  assert.match(
    job.instructions,
    /Never ask again for something the learner has already answered correctly/,
  );
  assert.match(
    job.instructions,
    /do not ask them to restate, complete or re-derive it/,
  );
  const assess = taskInstructions("assess", {}) as string;
  assert.ok(assess.includes(ASSESSMENT_HELP_GUIDANCE));
  assert.match(
    assess,
    /Judge each facet against what the question and the part it was asked in requested/,
  );
  assert.match(
    assess,
    /an element a rubric line requires that the ask did not name .* is not required, and its absence never makes a facet unknown or assisted; a false or unsupported claim still counts/,
  );
  assert.match(
    ASSESSMENT_HELP_GUIDANCE,
    /only repeats or rewords a part of the issued question/,
  );
  assert.match(
    job.instructions,
    /one focused question whose reasoning genuinely entails its prerequisites/,
  );
  assert.match(job.instructions, /never breadth inflation/);
  assert.match(job.instructions, /unasked unrelated facets marked established/);
  assert.match(job.instructions, /hidden full-project follow-up/);
  assert.match(job.instructions, /probe its parts next, one level down/);
  assert.match(job.instructions, /known parts never imply it/);
  assert.match(job.instructions, /optionally probe/);
  assert.match(job.instructions, /or wants to move on/);
  assert.doesNotMatch(job.instructions, /nothing lower is left to probe/);
  assert.doesNotMatch(job.instructions, /establishes the most at once/);
});

test("probe stance keeps bounded reasoning, one-level clarification and explicit gaps", () => {
  assert.ok(TERMINAL_DIALOGUE_INSTRUCTION.includes(PROBE_STANCE));
  assert.ok(PROBE_STANCE.includes(QUESTION_ADAPTATION_GUIDANCE));
  assert.match(PROBE_STANCE, /highest-leverage question/);
  assert.match(
    PROBE_STANCE,
    /focused reasoning whose correct answer necessarily entails other facets already in the issued task/,
  );
  assert.match(PROBE_STANCE, /leave all unasked siblings unknown/);
  assert.match(
    PROBE_STANCE,
    /Do not widen the question or add hidden project demands/,
  );
  assert.match(PROBE_STANCE, /mark Y and Z implied by X/);
  assert.match(
    PROBE_STANCE,
    /at most one directly relevant prerequisite question, one level down/,
  );
  assert.match(PROBE_STANCE, /known parts never imply the apex/);
  assert.match(
    PROBE_STANCE,
    /Requesting clarification alone is not evidence of partial knowledge, guessing or a gap/,
  );
});

test("study prompts carry no game framing and ask for interview-realistic questions", () => {
  for (const operation of ["generate", "tutor"]) {
    const text = taskInstructions(operation, {});
    assert.doesNotMatch(text, /zombie-escape|gameplay|the game\b/i, operation);
  }
  const generate = taskInstructions("generate", {});
  assert.match(generate, /real software engineering interview/);
  assert.match(generate, /Never set the question in a game, story/);
  assert.match(generate, /payload\.replaces/);
});

/** A question already issued on the contract a fresh record schedules first. */
function issue(
  g: any,
  id: string,
  seq: number,
  over: Record<string, unknown> = {},
  objectiveIds?: string[],
) {
  const e = g.encounters[id];
  const c = structuredClone(eligible(r, g.study));
  if (objectiveIds) c.objectiveIds = objectiveIds;
  e.problem = {
    title: `Title ${id}`,
    prompt: `Scenario ${id}. `.repeat(40),
    rubric: [],
    starter: "",
    provenance: "claude-cli",
    contract: c,
    ...over,
  };
  e.problemPresentedSequence = seq;
  e.state = "consumed";
  return e;
}

test("a generation request carries a short summary of the newest earlier questions on its objectives", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g: any = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    for (let i = 1; i <= 7; i++) issue(g, `question-${i}`, 9 + i);
    issue(g, "question-6", 15, { prompt: "Facts.\n\nWhat is the cause?" });
    issue(g, "question-3", 12, {
      staged: {
        shared: "S".repeat(400),
        parts: ["A".repeat(400), "short ask"],
      },
    });
    g.encounters["question-4"].tutor.push({
      id: "m",
      author: "You",
      kind: "human",
      text: "PRIVATE LEARNER ANSWER",
      seq: 1,
      worldTime: 0,
      provenance: "human",
    });
    issue(g, "question-8", 99, {}, ["OTHER:X"]);
    issue(g, "question-9", 98, { provenance: "development" });
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    const earlier = sent[0].earlierQuestions;
    // Newest first, five at most; another objective and stand-ins are left out.
    assert.deepEqual(
      earlier.map((x: any) => x.title),
      [7, 6, 5, 4, 3].map((i) => `Title question-${i}`),
    );
    for (const x of earlier) {
      assert.ok(x.opening.length <= 160);
      assert.deepEqual(Object.keys(x).sort(), ["asks", "opening", "title"]);
    }
    // A question shown whole has one ask: the last block of its prompt.
    assert.deepEqual(earlier[0].asks, []);
    assert.deepEqual(earlier[1].asks, ["What is the cause?"]);
    assert.equal(earlier[4].opening.length, 160);
    assert.equal(earlier[4].asks.length, 2);
    assert.ok(earlier[4].asks[0].length <= 160);
    assert.equal(earlier[4].asks[1], "short ask");
    assert.doesNotMatch(JSON.stringify(sent[0]), /PRIVATE LEARNER ANSWER/);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a first question's request has no earlier-question summary", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g = createRecord(r, initialStudy(r, "live"));
    await ensureProblem(g, g.encounters["question-0"], r);
    assert.equal("earlierQuestions" in sent[0], false);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("regenerate carries the replaced question's asks and keeps it out of the history", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = fixtureFetch(sent);
  try {
    await checkBridge();
    const g: any = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    e.studyOnly = true;
    issue(g, "question-0", 5, {
      staged: {
        shared: "Shared facts",
        parts: ["First ask text", "Second ask text"],
      },
    });
    e.state = "in-progress";
    issue(g, "question-1", 4);
    assert.equal(regenerateQuestion(g, e, r), true);
    const payload: any = e.pendingGeneration!.payload;
    assert.deepEqual(payload.replaces.asks, [
      "First ask text",
      "Second ask text",
    ]);
    assert.equal(payload.replaces.title, "Title question-0");
    assert.deepEqual(
      payload.earlierQuestions.map((x: any) => x.title),
      ["Title question-1"],
    );
    await ensureProblem(g, e, r);
    // JSON round trip: the transport drops undefined optional fields.
    assert.deepEqual(sent[0], JSON.parse(JSON.stringify(payload)));
    assert.equal(e.pendingGeneration, undefined);
    // A second regeneration is told about the first discarded question too,
    // which no other question holds, and the record survives a reload.
    const loaded: any = recover(decode(encode(g)));
    const again = loaded.encounters["question-0"];
    assert.equal(again.discardedQuestions[0].title, "Title question-0");
    assert.equal(regenerateQuestion(loaded, again, r), true);
    const next: any = again.pendingGeneration!.payload;
    assert.equal(next.replaces.title, again.discardedQuestions[0].title);
    assert.deepEqual(
      next.earlierQuestions.map((x: any) => x.title),
      ["Title question-0", "Title question-1"],
    );
    assert.deepEqual(next.earlierQuestions[0].asks, [
      "First ask text",
      "Second ask text",
    ]);
    assert.equal(again.discardedQuestions.length, 2);
    // At most five are kept, and a damaged entry is never sent.
    again.discardedQuestions = [
      null,
      ...Array(9).fill(again.discardedQuestions[1]),
    ];
    again.problem = structuredClone(loaded.encounters["question-1"].problem);
    again.state = "in-progress";
    assert.equal(regenerateQuestion(loaded, again, r), true);
    assert.equal(again.discardedQuestions.length, 5);
    assert.ok(
      (again.pendingGeneration!.payload as any).earlierQuestions.every(
        (x: any) => typeof x.title === "string",
      ),
    );
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

/** Like fixtureFetch, but each generate reply is chosen by its call number. */
function scriptedFetch(sent: any[], reply: (call: number, c: any) => Response) {
  return (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Isolated question design fixture",
        capabilities: ["generate", "tutor", "assess"],
        detail: "Test fixture only; not a native Study Mode verification.",
      });
    const body = JSON.parse(String(init?.body));
    sent.push(structuredClone(body.payload));
    return reply(sent.length - 1, body.payload.contract);
  }) as typeof fetch;
}
const fixtureProblem = (c: any, contract = c) => ({
  title: "Fixture question",
  prompt: "Isolated pipeline fixture.",
  starter: "",
  rubric: ["scope"],
  contract,
  scopeDefinitions: [
    {
      id: `${c.objectiveIds[0]}/D${c.depth}`,
      objectiveId: c.objectiveIds[0],
      depth: c.depth,
      sourceScope: c.scopes[0],
      facets: [{ id: "scope", description: "Complete scope fixture" }],
    },
  ],
});

test("a reply the app refuses is retried under a fresh request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = scriptedFetch(sent, (call, c) =>
    Response.json(fixtureProblem(c, call ? c : { ...c, depth: c.depth + 1 })),
  );
  try {
    await checkBridge();
    const g: any = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    assert.equal(e.problem, undefined);
    assert.ok(e.error);
    const first = sent[0];
    assert.notEqual(e.pendingGeneration.requestId, first.requestId);
    assert.equal(
      e.pendingGeneration.payload.requestId,
      e.pendingGeneration.requestId,
    );
    // Only the identity changes; the captured request is otherwise the same.
    assert.deepEqual(
      JSON.parse(
        JSON.stringify({
          ...e.pendingGeneration.payload,
          requestId: first.requestId,
        }),
      ),
      first,
    );
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1].requestId, first.requestId);
    assert.deepEqual(sent[1].contract, first.contract);
    assert.equal(e.problem?.title, "Fixture question");
    assert.equal(e.pendingGeneration, undefined);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("a transport failure keeps the saved request identity", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = scriptedFetch(sent, () =>
    Response.json({ error: "Synthetic outage" }, { status: 503 }),
  );
  try {
    await checkBridge();
    const g: any = createRecord(r, initialStudy(r, "live"));
    const e = g.encounters["question-0"];
    await ensureProblem(g, e, r);
    const saved = structuredClone(e.pendingGeneration);
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(e.pendingGeneration.requestId, saved.requestId);
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("minimum evidence leads generation and tutoring, and the shape rules come last", () => {
  const generate: string = taskInstructions("generate", {});
  const tutor: string = taskInstructions("tutor", {});
  const assess: string = taskInstructions("assess", {});
  for (const text of [generate, tutor])
    assert.ok(text.includes(MINIMUM_EVIDENCE_GUIDANCE));
  assert.doesNotMatch(generate, /patient study tutor approach/);
  assert.match(tutor, /patient study tutor approach/);
  // The shape block is the last thing the generator reads, and is sent once.
  assert.ok(generate.endsWith(QUESTION_SHAPE_GUIDANCE));
  assert.equal(generate.split(QUESTION_DESIGN_GUIDANCE).length, 2);
  assert.match(
    generate,
    /never drop a fact a correct answer needs; beyond that, cut/,
  );
  assert.match(
    generate,
    /one facet per distinct understanding, never one per list member/,
  );
  assert.match(generate, /ask for one of each kind and no more/);
  assert.match(
    generate,
    /Add an ask only when it tests something the first does not/,
  );
  // Each part asks for one thing, so a compound ask is split or cut.
  assert.match(
    generate,
    /a part asks for exactly one answer about one subject/,
  );
  assert.match(generate, /never merge asks to lower the part count/);
  assert.match(generate, /if it requests more than one answer/);
  assert.match(generate, /pick a real project of their own/);
  assert.match(generate, /at most four one-line facts/);
  assert.match(generate, /a learner who already has this skill needs/);
  assert.match(
    generate,
    /payload\.earlierQuestions[^.]*:[^.]*different scenario and a different shape of ask/,
  );
  assert.match(
    generate,
    /a fact only one part needs goes in that part's own text/,
  );
  assert.match(
    tutor,
    /A complete correct answer ends the question, or the part, at once/,
  );
  assert.match(tutor, /a reason that was not asked for is not required/);
  assert.match(
    PROBE_STANCE,
    /Facets of the same kind[^.]*are one facet repeated/,
  );
  assert.match(
    TERMINAL_DIALOGUE_INSTRUCTION,
    /as soon as the learner's messages and saved work supply a correct and complete answer/,
  );
  assert.match(
    assess,
    /never lower an outcome because a correct answer was short/,
  );
});
