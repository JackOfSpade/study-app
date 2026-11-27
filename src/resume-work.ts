/**
 * Work a reload, a closed tab or a lost relay cut off, which the app sends
 * again by itself, as the same saved request, once Claude can be reached.
 * Nothing here was refused: a reply the relay or the app rejected keeps its
 * explicit retry button and is never resent without the learner.
 */
import { encounterKey } from "./learner";
import {
  allEncounters,
  type Assessment,
  type Encounter,
  type StudyRecord,
  type TutorRequest,
} from "./model";

/** What loading writes on a tutor request the page closed on (persistence.ts
 * `recover`). Earlier builds resent such a request once and then marked it
 * `resent`. */
export const RESTARTED_TUTOR =
  "Application restarted; retry the exact saved private question.";
/** The provenance loading writes on an assessment the page closed on
 * (persistence.ts `recover`). */
export const RESTARTED_ASSESSMENT =
  "Application restarted during assessment. Evidence cutoff and request identity retained for retry.";
/** Loading's restart note (its first alternative is the opening of
 * `RESTARTED_ASSESSMENT`), and what earlier builds wrote for an assessment cut
 * off by a lost connection. A request this build sends says so in `resume`
 * instead. */
const CUT_OFF_ASSESSMENT =
  /^(Application restarted during assessment|Live assessment connection unavailable|Assessment unresolved: (TypeError: (Failed to fetch|Load failed|NetworkError)|Error: The study bridge is not running|Error: Study bridge unavailable|Error: The reply ended before its answer arrived))/;

/** Finished questions' assessments that were only cut off, with the question
 * each one reviews. */
export function resumableAssessments(g: StudyRecord) {
  if (g.study.profile !== "live") return [];
  const questions = allEncounters(g);
  const found: { assessment: Assessment; encounter: Encounter }[] = [];
  for (const a of g.study.assessments) {
    if (
      a.status !== "review-required" ||
      !(a.resume ?? CUT_OFF_ASSESSMENT.test(a.provenance)) ||
      a.request?.provider !== "claude-cli"
    )
      continue;
    const e = questions.find(
      (q) =>
        q.id === a.encounter &&
        a.id.startsWith(`assessment-${encounterKey(q)}-`),
    );
    if (e) found.push({ assessment: a, encounter: e });
  }
  return found;
}

/**
 * The learner's last message on this question, when its tutor request was cut
 * off and nothing has been said since. It is sent again as the same request,
 * so the turn is neither lost nor doubled.
 */
export function resumableTutorRequest(e: Encounter): TutorRequest | undefined {
  const job = e.tutorRequests?.at(-1);
  const last = e.tutor.at(-1);
  if (
    !job ||
    job.state !== "interrupted" ||
    job.provider !== "claude-cli" ||
    !(job.resume ?? (job.error === RESTARTED_TUTOR && !job.resent)) ||
    last?.kind !== "human" ||
    last.seq !== job.questionSequence
  )
    return undefined;
  return job;
}
