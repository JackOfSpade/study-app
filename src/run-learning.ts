import type { Encounter, TutorRequest } from "./model";
import { isRecord } from "./records";

/** Static roadmap texts re-derivable from the curriculum; never re-read once settled. */
const RELEASED_REQUEST_FIELDS = ["curriculum", "progressContext"] as const;
/**
 * What a settled tutor request also gives up: the instruction and reply
 * format (constants of the code), and its own copies of the question, the
 * probe and the whole conversation so far, its draft, submissions and run results, all of
 * which the question itself holds. A settled request is never sent or read again, and
 * the conversation copy made each one larger than the last, so a long
 * conversation grew the save by tens of kilobytes per message. What stays
 * identifies the request: its ids, mode, the learner's message, the draft
 * revision, the open part and the help policy it was sent under.
 */
const RELEASED_TUTOR_FIELDS = [
  ...RELEASED_REQUEST_FIELDS,
  "instruction",
  "responseFormat",
  "messages",
  "problem",
  "probe",
  "learning",
  "workspace",
  "submissions",
  "executions",
] as const;
/** What a settled request keeps of its topic-assessment context. */
const KEPT_TOPIC_CONTEXT_FIELDS = new Set([
  "topicIds",
  "depth",
  "sourceHash",
  "frozenBeforeCurrentConversation",
]);

/** Drop from a stored request what is held elsewhere; keeps what identifies it. */
function releaseRequestContext(
  job: { payloadJson: string },
  fields: readonly string[] = RELEASED_REQUEST_FIELDS,
): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(job.payloadJson);
  } catch {
    return false;
  }
  if (!isRecord(payload)) return false;
  const record = payload;
  let removed = false;
  for (const field of fields)
    if (field in record) {
      delete record[field];
      removed = true;
    }
  // The learner snapshot sent for the topic assessment is about 100 kB per
  // request. A settled request is never sent again, so only what identifies
  // the snapshot stays.
  const context = record.topicAssessmentContext;
  if (
    isRecord(context) &&
    Object.keys(context).some((key) => !KEPT_TOPIC_CONTEXT_FIELDS.has(key))
  ) {
    record.topicAssessmentContext = Object.fromEntries(
      Object.entries(context).filter(([key]) =>
        KEPT_TOPIC_CONTEXT_FIELDS.has(key),
      ),
    );
    removed = true;
  }
  if (removed) job.payloadJson = JSON.stringify(record);
  return removed;
}

export function settleTutorRequest(
  job: TutorRequest,
  state: "applied" | "superseded",
): void {
  job.state = state;
  delete job.resume;
  releaseRequestContext(job, RELEASED_TUTOR_FIELDS);
}

/** A new message, or the next part, replaces any request left interrupted. */
export function supersedeInterrupted(e: Encounter): void {
  for (const job of e.tutorRequests ?? [])
    if (job.state === "interrupted") settleTutorRequest(job, "superseded");
}

/** End a question at a run boundary without declaring its unanswered facets gaps. */
export function closeDirectStudy(e: Encounter): void {
  const s = e.directStudy;
  if (!s || !["pending", "interrupted", "paused"].includes(s.state)) return;
  s.state = "superseded";
  delete s.error;
  delete s.transportPhase;
  delete s.transportPhaseAt;
}

export function releaseSettledRequests(e: Encounter, all = false): void {
  for (const job of e.tutorRequests ?? [])
    if (all || job.state === "applied" || job.state === "superseded")
      releaseRequestContext(job, RELEASED_TUTOR_FIELDS);
  // The retired chat's session keeps its question, which loading checks. A
  // pending/interrupted direct question keeps its exact frozen payload even
  // when archived; only settled sessions may drop static context.
  const direct = e.directStudy;
  if (
    direct &&
    typeof direct.payloadJson === "string" &&
    (direct.state === "applied" || direct.state === "superseded")
  )
    releaseRequestContext(direct);
}

const DIRECT_STATES = new Set([
  "pending",
  "interrupted",
  "paused",
  "applied",
  "superseded",
]);
/** Validate a saved direct session as data; malformed sessions become interrupted. */
export function recoverDirectStudy(e: Encounter): void {
  // Saved data: validated as unknown, whatever the model type says.
  const s: unknown = e.directStudy;
  if (s === undefined) return;
  if (!isRecord(s)) {
    delete e.directStudy;
    return;
  }
  const malformed = (reason: string) => {
    if (s.state === "applied" || s.state === "superseded") return;
    s.state = "interrupted";
    s.error = `Saved chat question is malformed (${reason}); it cannot be retried.`;
  };
  delete s.transportPhase;
  delete s.transportPhaseAt;
  if (typeof s.state !== "string" || !DIRECT_STATES.has(s.state)) {
    s.state = "interrupted";
    s.error = "Saved chat question had an unknown state; it cannot be retried.";
  }
  if (
    typeof s.id !== "string" ||
    !s.id ||
    typeof s.questionFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.questionFingerprint) ||
    typeof s.payloadJson !== "string"
  )
    return malformed("identity");
  let payload: unknown;
  try {
    payload = JSON.parse(s.payloadJson);
  } catch {
    return malformed("payload");
  }
  if (
    !isRecord(payload) ||
    payload.requestId !== s.id ||
    payload.questionFingerprint !== s.questionFingerprint ||
    payload.mode !== "terminal-direct" ||
    !payload.problem ||
    typeof payload.problem !== "object"
  )
    return malformed("payload binding");
  if (s.state === "pending") {
    s.state = "interrupted";
    s.error =
      "Application restarted while this question was open in the retired chat; the saved question is kept but cannot be resumed.";
  }
}
