import { isRecord as object } from "./is-record.mjs";
import { PARTS_GENERATION_GUIDANCE } from "./question-parts.mjs";
import {
  CODE_IN_PROSE_GUIDANCE,
  MINIMUM_EVIDENCE_GUIDANCE,
  QUESTION_SHAPE_GUIDANCE,
} from "./study-question-policy.mjs";

/**
 * The review stage of `generate`: a second, fresh read of a question the
 * writer has just returned, with the job of fixing what a careful reviewer
 * would send back. One pass that writes a question and checks it at once
 * keeps missing the same faults (2026-11-28: a rubric line that requires more
 * than its ask names, a later part that leans on an earlier answer it does not
 * restate, a premise that hands over the answer); an independent reader finds
 * them reliably. The reviewer may change only the text the learner reads and
 * the rubric. The contract and scope definitions stay the writer's, so a review
 * can never move the assessed scope.
 */

/** The fields a review may replace; everything else stays the writer's. */
export const REVIEWABLE_FIELDS = Object.freeze([
  "title",
  "prompt",
  "parts",
  "starter",
  "rubric",
  "estimatedSolveSeconds",
  "partSolveSeconds",
]);

const REVIEW_TASK = `You review one interview-practice question that another writer has just produced, before a learner sees it. Read it as the learner will, one part at a time with the shared prompt, and as the grader will, with the rubric. Check, in this order:
1. One ask per part: each part asks for exactly one answer about one subject; "and why" for its one answer is allowed when the reasoning is assessed; no second request, "for each" over items whose reasons read the same, or answer-layout instruction.
2. Bite-sized: each part fits ten minutes for a learner who has the skill, and no part is padding.
3. Order and overlap: parts run in the order the reasoning runs (a diagnosis before the remedy it supports), and no later part tests what a complete answer to the earlier parts, including their reasons, already shows.
4. Answer check: answer each part yourself from the shared prompt and that part alone. Its words must ask for the answer the rubric expects; a later part that needs an earlier step's result states it in one short line; nothing in the prompt or a part (a premise, a guideline, a definition, the wording of an item) gives away the answer to that part or a later one.
5. Rubric: for every element a rubric line requires, find the words of its ask that request it; an element with none is cut from the line, or named in the ask when the skill needs it. Each line accepts every correct answer the facts support (check it against a second correct route) and is one checkable judgement.
6. Short reading and realism: only the facts a correct answer turns on, code in backticks, a plausible interview setting.
Fix every fault you find with the smallest edit that removes it, keeping the scenario, the skill tested, the number of parts unless a fault requires a change, and everything that is already right. Never make the question easier than its depth calls for, never reveal an answer, and add nothing that narrows the learner's search: no new fact, category list, label, name or qualifier that points at an answer (for example calling a claim "based on a handful of tickets" or a failure "temporary" when judging that is the task). Removing a give-away is a fix; adding one never is. Never reword an ask so that it names or describes what the answer must point to (for example asking how to make a screen reader announce "the visible Caption text" when finding that association is the task), and never cut an ask's "and why" when its facet assesses the reasoning. Cutting a rubric element the ask does not name is a fix; cutting one the ask does name is not. Keep every part's rubric coverage: the rubric still has at least one line for each part. The writer followed these rules, quoted for reference:

${MINIMUM_EVIDENCE_GUIDANCE}

${PARTS_GENERATION_GUIDANCE}

${QUESTION_SHAPE_GUIDANCE}

${CODE_IN_PROSE_GUIDANCE}

Return one JSON object and nothing else. When nothing needs changing: {"verdict":"ok"}. Otherwise: {"verdict":"revised","changes":["one short line per fault fixed"],"title":string,"prompt":string,"parts":[string],"starter":string,"rubric":[string],"estimatedSolveSeconds":number,"partSolveSeconds":[number]}, with every field present and holding the whole revised value, including the ones you left unchanged.`;

/** The system and user text for one review. The system text depends on
 * nothing per question, so consecutive reviews share a cached prompt. */
export function reviewPrompt(payload, answer) {
  const contract = object(payload?.contract) ? payload.contract : {};
  return {
    system: REVIEW_TASK,
    user: JSON.stringify({
      contract: {
        track: contract.track,
        depth: contract.depth,
        objectiveIds: contract.objectiveIds,
        scopes: contract.scopes,
      },
      scopeDefinitions: answer.scopeDefinitions,
      question: Object.fromEntries(
        REVIEWABLE_FIELDS.filter((key) => answer[key] !== undefined).map(
          (key) => [key, answer[key]],
        ),
      ),
    }),
  };
}

/**
 * The question to deliver after a review reply: the writer's own answer when
 * the reviewer found nothing, or the writer's answer with only the reviewable
 * fields replaced. Throws when the reply is neither, so the caller keeps the
 * writer's answer.
 */
export function applyReview(answer, review) {
  if (!object(review)) throw Error("The review reply was not a JSON object");
  if (review.verdict === "ok") return { answer, changes: [] };
  if (review.verdict !== "revised")
    throw Error('The review verdict must be "ok" or "revised"');
  const missing = REVIEWABLE_FIELDS.filter(
    (key) => review[key] === undefined && answer[key] !== undefined,
  );
  if (missing.length)
    throw Error(`The revised question is missing ${missing.join(", ")}`);
  if (
    Array.isArray(answer.parts) &&
    Array.isArray(review.rubric) &&
    Array.isArray(review.parts) &&
    review.rubric.length < review.parts.length
  )
    throw Error(
      "The revised rubric has fewer lines than the question has parts",
    );
  const revised = { ...answer };
  for (const key of REVIEWABLE_FIELDS)
    if (review[key] !== undefined) revised[key] = review[key];
  const changes = Array.isArray(review.changes)
    ? review.changes.filter((line) => typeof line === "string").slice(0, 20)
    : [];
  return { answer: revised, changes };
}
