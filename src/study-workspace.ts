import { studyMapHtml } from "./study-map";
import { eligible, syncLearningView } from "./curriculum";
import { encounterKey, interruptLearningAttempt } from "./learner";
import {
  allEncounters,
  type Assessment,
  type Encounter,
  type StudyRecord,
  type Roadmap,
} from "./model";

export function enterStudyWorkspace(g: StudyRecord) {
  if (!g.studyWorkspace?.enabled)
    g.studyWorkspace = { ...g.studyWorkspace, enabled: true };
}

/** Prefer the actual unfinished task over creating another visit or chat. */
export function workspaceQuestion(g: StudyRecord): Encounter | undefined {
  const current = Object.values(g.encounters);
  const selected = workspaceSelectedQuestion(g);
  const available = (e: Encounter) =>
    e.state !== "consumed" && !(e.owner && e.owner !== "human");
  const preferSelected = (
    candidates: Encounter[],
    matches: (e: Encounter) => boolean,
  ) =>
    selected && candidates.includes(selected) && matches(selected)
      ? selected
      : candidates.find(matches);
  const pending = preferSelected(
    current,
    (e) =>
      available(e) &&
      (e.studyOnly || e.owner === "human" || e.id === g.lastStudyEncounter) &&
      !!(e.pendingGeneration || e.generation),
  );
  if (pending) return pending;
  const bound =
    g.study.pending?.encounter ??
    g.study.learner?.attempts.find((a) => a.status === "in-progress")
      ?.encounter;
  if (bound) {
    const e = current.find((e) => encounterKey(e) === bound && available(e));
    if (e) return e;
  }
  return preferSelected(
    current,
    (e) =>
      available(e) &&
      !!(
        e.studyOnly ||
        (e.problem && e.problemPresentedSequence !== undefined)
      ),
  );
}

/** The next question for the learner; no scope changes are needed. */
export function nextWorkspaceQuestion(
  g: StudyRecord,
  roadmap: Roadmap,
): Encounter {
  if (!g.studyWorkspace?.enabled)
    throw Error("Open the study workspace first.");
  const assessment = workspaceAssessment(g);
  const learner = g.study.profile === "live" ? g.study.learner : undefined;
  if (learner) {
    // A finished conversation cannot accept more answers. An unresolved
    // assessment keeps its formal visit open, so retain it as a continuation
    // before issuing fresh work. The normal scheduler still owns track order.
    const unfinished = new Set(
      learner.attempts
        .filter((a) => ["in-progress", "suspended"].includes(a.status))
        .map((a) => a.encounter),
    );
    let interrupted = false;
    for (const e of allEncounters(g))
      if (
        unfinished.has(encounterKey(e)) &&
        e.state === "consumed" &&
        assessmentForQuestion(g, e)?.status === "applied"
      ) {
        interruptLearningAttempt(learner, e);
        interrupted = true;
      }
    if (interrupted) syncLearningView(g.study);
  }
  const current = workspaceQuestion(g);
  if (current) {
    g.studyWorkspace.encounter = encounterKey(current);
    return current;
  }
  if (assessment && assessment.status !== "applied")
    throw Error(
      "Finish reviewing your previous learning result before starting another question.",
    );
  // Respect curriculum gates before allocating any new saved task.
  eligible(roadmap, g.study);
  return newWorkspaceEncounter(g);
}

/**
 * A new, empty question for a practice re-test of a recorded gap. The caller
 * seeds its generation (`seedGapPractice`). Refused while another question is
 * unfinished or a learning result is still under review, as a normal next
 * question is; the scheduler is not consulted because practice is not a visit.
 */
export function gapPracticeQuestion(g: StudyRecord): Encounter {
  if (!g.studyWorkspace?.enabled)
    throw Error("Open the study workspace first.");
  if (workspaceQuestion(g))
    throw Error("Finish your open question before testing this gap.");
  const assessment = workspaceAssessment(g);
  if (assessment && assessment.status !== "applied")
    throw Error(
      "Finish reviewing your previous learning result before starting another question.",
    );
  return newWorkspaceEncounter(g);
}

function newWorkspaceEncounter(g: StudyRecord): Encounter {
  const id = `study-${crypto.randomUUID()}`;
  const e: Encounter = {
    id,
    runId: g.id,
    studyOnly: true,
    mode: "solo",
    state: "available",
    owner: "human",
    workspace: "",
    revision: 0,
    history: [],
    tutor: [],
    submissions: [],
    contributors: [],
    chatOpen: false,
    scroll: 0,
    selection: [0, 0],
  };
  g.encounters[id] = e;
  g.studyWorkspace!.encounter = encounterKey(e);
  return e;
}

export function workspaceAssessment(g: StudyRecord) {
  if (g.study.profile !== "live") return undefined;
  const e = workspaceSelectedQuestion(g);
  return e ? assessmentForQuestion(g, e) : undefined;
}

/** Whether an assessment was written for this question. Its ID is scoped to
 * the question's key; a legacy unscoped ID is trusted only when the
 * question's own ID is unambiguous, since older saves reused question IDs
 * across their runs. */
function assessesQuestion(
  g: StudyRecord,
  a: Assessment,
  e: Encounter,
): boolean {
  if (a.encounter !== e.id) return false;
  if (a.id.startsWith(`assessment-${encounterKey(e)}-`)) return true;
  return (
    !a.id.startsWith("assessment-") &&
    allEncounters(g).every(
      (other) => other.id !== e.id || encounterKey(other) === encounterKey(e),
    )
  );
}

function assessmentForQuestion(g: StudyRecord, e: Encounter) {
  for (let i = g.study.assessments.length - 1; i >= 0; i--)
    if (assessesQuestion(g, g.study.assessments[i], e))
      return g.study.assessments[i];
  return undefined;
}

/** The saved question an assessment was written for, if it is still saved. */
export function questionForAssessment(
  g: StudyRecord,
  a: Assessment,
): Encounter | undefined {
  return allEncounters(g).find((e) => assessesQuestion(g, a, e));
}

export function workspaceSelectedQuestion(g: StudyRecord) {
  return allEncounters(g).find(
    (e) => encounterKey(e) === g.studyWorkspace?.encounter,
  );
}

/** Counts come from the learner ledger; observations are separate. */
export function workspaceProgressHtml(
  g: StudyRecord,
  roadmap: Roadmap,
  open = workspaceQuestion(g),
): string {
  return studyMapHtml(g, roadmap, open?.problem?.contract);
}
