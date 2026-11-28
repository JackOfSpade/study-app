import { isRecord as object } from "./is-record.mjs";

/**
 * A question worked one part at a time. Generation returns the shared
 * material as `prompt` and each ask as an entry of `parts`; the learner sees
 * the shared material with one part. Once the tutor confirms it
 * (`partComplete`) the learner is offered the next part, which replaces it
 * when they ask for it, while the conversation stays on screen. It stays one question: one conversation, one
 * completion and one assessment.
 */
// The number of parts has no limit: a cap pushes the writer to pack two asks
// into one part. Neither has the question's total solve time (removed on
// 2026-11-27): a long problem is fine because it is worked in parts, and it is
// each part that is kept short, so a wrong turn costs one part, not the whole
// question.
const MAX_PART_CHARS = 6000;
/** The longest a single part may take a learner who has the skill. */
export const PART_SOLVE_SECONDS_MAX = 600;

export const PARTS_GENERATION_GUIDANCE = `One part at a time: the learner works a question one ask at a time, so also return parts, an array of one or more strings, one per thing the learner is asked for, and keep prompt for the shared material only. Wherever these instructions say the question or the prompt must supply or show something, that means prompt and the part on screen read together. prompt holds the scenario, code, data, interfaces and fixed facts that two or more parts need, or all of the material when there is one part, and asks nothing itself: no numbered questions and no 'answer the following'. Each entry of parts is one complete ask, in the order to be worked, worded as it should appear on screen and without a number or a 'Part' label, which the app adds. The learner first sees prompt with parts[0] only; each later part replaces the one before it after the tutor confirms that one, and prompt stays on screen throughout. So every part must be answerable from prompt and its own text: a fact two or more parts need goes in prompt; a fact only one part needs goes in that part's own text, so the learner does not read material up front that the open part never uses; a fact a later part needs must never appear only in an earlier part. Steps toward one solution: the question's total length has no limit, but each part is bite-sized, at most ${PART_SOLVE_SECONDS_MAX / 60} minutes for a learner who has the skill, because the learner moves on only once the tutor confirms the part, so a wrong turn costs one part rather than the whole question. A problem whose full solution takes longer (an interview coding problem, an implementation, a design, a multi-step derivation or a debugging session) is kept whole when the objective calls for a problem that size, never shrunk to fit, and cut into the consecutive steps a strong candidate would take toward the whole solution, in order, each a checkpoint whose answer can be judged on its own. Implementation is no exception: a long implementation is built over several parts, one function, method or distinct piece of behaviour per part (cases of the same kind stay together in one part, or one is kept and the rest dropped, as for any items of one kind), each added to the same code and confirmed before the next opens, never asked for whole in one part; the part says what to add, and the learner's own code from earlier parts stays in their workspace and the conversation, so the part builds on it without repeating it. A later part builds on the confirmed result of the parts before it: when it needs an earlier step's result (a value, a data shape, a fixed decision the question made, or for code the interface and behaviour of what earlier parts built, never their code), it states that result in one short line before its ask, as the starting point, so the learner continues from the right state even after giving that step up; the earlier part is finished by then, so this gives nothing away. When the earlier step was an open choice for the learner, the later part instead says to continue with the approach they chose and the tutor confirmed (or, if they gave that step up, the one the tutor named when closing it), never names one itself, and must work for any reasonable choice. A part never depends on the exact wording of an earlier answer. prompt and each part must not give away the answer to that part or to a later one. One thing per part: a part asks for exactly one answer about one subject, so the learner never faces two requests at once. One operation, one case, one decision or one value is one part, and so is an implementation that fits within one part's time; a longer one is several steps, as Steps toward one solution above says. A part that joins two requests with 'and', asks about two subjects (the cost of one operation and of another), says 'do the same for' or 'for each', or follows its ask with a second instruction about how to lay the answer out, is several asks: give each its own part, or cut the ones the skill does not need. Prefer cutting. The number of asks is still the fewest that prove the skill, and several short parts beat one crowded part; never merge asks to lower the part count, which has no limit. Check each part before returning: it holds one question or one instruction, never one of each and never two. 'Which would you use, and why? Give its cost.' is two parts, the choice with its reason and then the cost; 'state the time and the space' asks for two values, so ask for the one the skill turns on or give each a part. A part's ask is one short sentence where it can be; a part may ask for the reason behind its one answer in a few words such as 'and why' when the objective assesses that reasoning, and for nothing else beside it. Facts only that part needs come before the ask in the same part, kept as short as the facts allow. A follow-up that tests something the main question does not is likewise a separate part. Order and overlap: parts run in the order the reasoning runs, so a part never asks for a conclusion whose justification is a later part's answer; a diagnosis comes before the remedy it supports (why the existing tests missed a bug, then which kind of test would catch it), never after. A later part tests only what a complete answer to the parts before it, including any reason they ask for, does not already show: if an earlier part's 'and why' would already state a later part's answer, cut one of the two. An ask that has the learner review their own answer once it is given (for example naming the claim in it most open to challenge) tests something the answer itself does not: when the question keeps it, it is always the last part, never a closing sentence of another part. A question that asks for one thing has one part unless answering it takes longer than one part may, when it becomes consecutive steps; a part is never added to pad.`;

export const PARTS_TUTOR_GUIDANCE =
  "One part at a time (whenever payload.stage is present): the learner is shown this question in parts. They see problem.staged.shared and only part payload.stage.part of payload.stage.of, whose text is payload.stage.question; earlier parts are finished and later parts are hidden from them. Work only on the current part: judge the answers against what this part asks, and never mention, quote, preview or ask about a later part, or ask for anything that only a later part asks. Add partComplete (true or false) to every reply. Return partComplete:true with complete:false when everything this part asks has been answered correctly and accepted (later parts build on this one, so a wrong or incomplete step is never passed on as answered), or when the learner says they do not know what remains of it or wants to move on from it (then record each facet they gave up as a gap in knowledge.facets, and when what they gave up is an open choice or a result later parts build on, name in one sentence a reasonable choice or the correct result to continue from, since the next part relies on it). In that reply text confirms in one or two sentences what was accepted, and what was left open if anything was; it asks no question and does not introduce the next part, because the app then shows the learner a button that opens the next part. Until they press it the same part stays open and payload.stage.confirmed is true: the learner may ask more about this part, so answer what they ask, keep partComplete:true and still do not introduce the next part. When they press it the app shows the next part in place of this one; the conversation stays on their screen, with a marker where the part ended. payload.stage.since, when present, is the seq of the last message before the current part opened: messages up to that seq belong to earlier parts, while later messages were written with the current part on screen. The learner usually answers a new part straight away without restating it, so read every learner message after payload.stage.since as an answer to payload.stage.question, never as a late answer to an earlier part, and never ask them to repeat or paste the question. The learner can still scroll back to earlier messages, but the text of an earlier part is folded away, so when you rely on something from an earlier part say what it was. Otherwise return partComplete:false and follow up on this part only. While payload.stage.part is less than payload.stage.of never return complete:true: the app rejects it, because the learner has not seen the remaining parts. On the last part partComplete stays false and complete:true finishes the whole question as usual, judged over every part.";

/** Why `parts` on a generated problem is malformed, or undefined when it is
 * absent (a question shown whole) or well formed. */
export function partsProblem(parts) {
  if (parts === undefined) return undefined;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    !parts.every(
      (part) =>
        typeof part === "string" &&
        part.trim() &&
        part.length <= MAX_PART_CHARS,
    )
  )
    return "parts must be an array of one or more nonempty strings, one per ask";
  return undefined;
}

/** Why a generated question's per-part solve times are missing, malformed
 * or over the limit, or undefined. `partSolveSeconds` has one entry per
 * entry of `parts`, or one entry for a question with no `parts`. The figures
 * are the writer's own estimate, so the caller treats an overrun as advice
 * for one correction, never as grounds to refuse a question outright. */
export function partSizeProblem(answer) {
  if (!object(answer)) return undefined;
  const count = Array.isArray(answer.parts) ? answer.parts.length : 1;
  const times = answer.partSolveSeconds;
  if (
    !Array.isArray(times) ||
    times.length !== count ||
    !times.every((t) => typeof t === "number" && Number.isFinite(t) && t > 0)
  )
    return `Return partSolveSeconds, an array of ${count} number${count === 1 ? "" : "s"}, one positive number per entry of parts in the same order: the seconds a learner who already has the skill needs for that part alone.`;
  // A short part is never worth a second generation; only an overrun is.
  const long = times.findIndex((t) => t > PART_SOLVE_SECONDS_MAX);
  if (long === -1) return undefined;
  return `parts[${long}] is estimated at ${times[long]} seconds, over the ${PART_SOLVE_SECONDS_MAX}-second limit for one part. First cut any ask in it the skill does not need; then split what remains into consecutive steps, each its own part that the tutor confirms before the next opens and that builds on the steps before it; for code, one function, method or distinct piece of behaviour per part, added to the same code. Do not drop a step the whole problem needs just to fit. Return one partSolveSeconds entry per part, and keep prompt, rubric and scopeDefinitions consistent with the result.`;
}

const ASK_VERBS =
  "give|name|state|explain|list|describe|say|propose|identify|show|justify|compare|estimate|calculate|compute|pick|choose|write|implement|define|derive|trace|predict|rank|outline|suggest";
// An instruction to the learner: an ask verb opening the sentence, or coming
// straight after a short lead-in clause ("For A, give ..."), unless the word
// is a noun there ("State is kept in Redis.", "List `a` holds ...").
const INSTRUCTION = new RegExp(
  `^(?:[^,.?]{0,60}, )?(?:then |also |next |finally |now )?(?:${ASK_VERBS})\\b(?! (?:is|are|was|were|has|have|holds?|of|\\w+s? (?:is|are|holds?))\\b)`,
  "i",
);
// A bare request for the reason belongs to the ask before it.
const BARE_REASON =
  /^(?:and )?(?:why(?: not| so)?|explain why|justify (?:it|your (?:answer|choice)))[.?]?$/i;

/** The sentences of one part that each request something from the learner. */
export function partRequests(part) {
  return String(part)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, "x")
    .split(/(?<=[.?!:])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s>*\-\d.)]+/, "").trim())
    .filter(
      (sentence) =>
        sentence &&
        !BARE_REASON.test(sentence) &&
        (sentence.endsWith("?") || INSTRUCTION.test(sentence)),
    );
}

// A request repeated over a list of items ("For each, say ...", "after each
// of events 1-5", "label each"), as opposed to code that loops ("for each user").
const PER_ITEM =
  /\b(?:(?:for|after) each(?:,| of\b| one\b)|(?:label|classify) each\b)/i;

// A request for a count of items ("Name the two assumptions", "give three
// risks"), as opposed to one value ("the two-pointer method", "two times").
const COUNTED =
  /\b(?:give|name|list|identify|state|suggest|propose)\s+(?:the\s+|any\s+|at least\s+|up to\s+)?(?:two|three|four|five|[2-5])\s+(?!(?:times|minutes|seconds|ms|hours|days)\b)[a-z][\w-]*/i;

/** Why a generated part asks for more than one thing, or undefined. This is
 * a reading of prose, so the caller treats it as advice for one correction,
 * never as grounds to refuse a question outright. */
export function compoundPartProblem(parts) {
  if (!Array.isArray(parts)) return undefined;
  for (const [index, part] of parts.entries()) {
    if (typeof part !== "string") continue;
    const requests = partRequests(part);
    const same = /\bdo the same\b/i.test(part);
    const prose = part
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`\n]*`/g, "x");
    const perItem = PER_ITEM.exec(prose);
    const counted = COUNTED.exec(prose);
    if (requests.length < 2 && !same && !perItem && !counted) continue;
    const quoted = requests.map((r) => `"${r.slice(0, 90)}"`).join(", ");
    const items = perItem
      ? ` '${perItem[0]}' asks for one answer per item: ask about the one most revealing item, or give an item that needs different reasoning its own part.`
      : counted
        ? ` '${counted[0]}' asks for several items of one kind: ask for the one that matters most, unless each item tests something the others do not, then give each its own part.`
        : "";
    return `parts[${index}] asks for more than one thing${quoted ? ` (${quoted})` : ""}.${items} Each part asks for exactly one answer about one subject, and the learner must never face two requests at once. Keep one request in that part and give each other request its own part, in the order to be worked, or cut a request the skill does not need. Do not join the requests into one sentence with 'and', and do not add 'do the same for'. Check every other part the same way, and keep prompt, rubric and scopeDefinitions consistent with the result.`;
  }
  return undefined;
}

/** The whole question as one text: what every reader other than the staged
 * display uses (assessment, history, reports). */
export function composePrompt(shared, parts) {
  const material = shared.trim();
  const asks =
    parts.length === 1
      ? [parts[0].trim()]
      : parts.map(
          (part, i) => `**Part ${i + 1} of ${parts.length}**\n\n${part.trim()}`,
        );
  return [material, ...asks].filter(Boolean).join("\n\n");
}

/** The parts of a stored problem that is worked one part at a time. */
export function stagedParts(problem) {
  const staged = object(problem) ? problem.staged : undefined;
  if (
    !object(staged) ||
    typeof staged.shared !== "string" ||
    !Array.isArray(staged.parts) ||
    staged.parts.length < 2 ||
    !staged.parts.every((part) => typeof part === "string")
  )
    return undefined;
  return staged.parts;
}

/** The request's own account of which part is open: {part, of}, 1-based. */
function requestStage(payload) {
  const stage = object(payload) ? payload.stage : undefined;
  if (
    !object(stage) ||
    !Number.isInteger(stage.part) ||
    !Number.isInteger(stage.of) ||
    stage.part < 1 ||
    stage.part > stage.of
  )
    return undefined;
  return stage;
}

/** Whether this reply closes the request's current part and opens the next. */
export function closesPart(payload, answer) {
  const stage = requestStage(payload);
  return (
    !!stage &&
    stage.part < stage.of &&
    answer.partComplete === true &&
    answer.complete !== true
  );
}

/** Why a tutor reply breaks the one-part-at-a-time rule, or undefined. */
export function partReplyProblem(payload, answer) {
  const stage = requestStage(payload);
  if (!stage) return undefined;
  if (
    answer.partComplete !== undefined &&
    typeof answer.partComplete !== "boolean"
  )
    return "partComplete must be true or false";
  if (answer.complete === true && stage.part < stage.of)
    return `The learner has only seen part ${stage.part} of ${stage.of}, so the question cannot be complete yet. To leave this part, whether it is answered or the learner wants to move on, return complete:false with partComplete:true and no outcome, and record any facet they gave up as a gap in knowledge.facets.`;
  return undefined;
}
