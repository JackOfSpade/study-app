import type { BrowserStep } from "../scripts/browser-runner/spec.mjs";
import type { DeclaredHelp } from "../scripts/lib/help-gate.mjs";
import type { EnvironmentObservation } from "./environment-observations";
import type { EnvironmentReviewJob } from "./environment-review";
import type { WorkspaceExecution } from "./execution";
import type {
  KnowledgeEstablishedRecord,
  KnowledgeGapRecord,
  KnowledgeProbe,
} from "./knowledge-probe";
import type {
  CareerFocus,
  HistoricalFacetMapping,
  LearnerLedger,
  ReviewRecord,
  ScopeDefinition,
} from "./learning-model";
import type {
  RoadmapAdoptionBackup,
  RoadmapReconciliationJob,
} from "./roadmap-adoption-types";
import type { RoadmapExport } from "./roadmap-export";
import type { IdentifierCounters } from "./roadmap-identifiers";
import type { TopicAssessmentRecord } from "./topic-assessment";
export type Track = "PY" | "PE";
/** Every connected AI provider; development practice has no provider. */
export const PROVIDERS = [
  "study-mode",
  "chatgpt-handoff",
  "claude-cli",
] as const;
/** A connected AI provider; development practice has no provider. */
export type Provider = (typeof PROVIDERS)[number];
export function isProvider(value: unknown): value is Provider {
  return (PROVIDERS as readonly unknown[]).includes(value);
}
/** A provider request saved verbatim, so a retry sends exactly the same one. */
export interface SavedRequest {
  provider: Provider;
  payloadJson: string;
}
export interface Objective {
  id: string;
  target: number;
  cells: string[];
  route: string;
  refs: string;
  reviewDue: string | null;
  scope: string;
}
export interface Roadmap {
  resume?: {
    ratioPosition?: number;
    issues: string[];
    reviews?: Record<string, ReviewRecord>;
    identifierCounters?: IdentifierCounters;
  };
  documentId: string;
  revision: number;
  sourceHash: string;
  raw: string;
  sharedProgress: string;
  tracks: Record<
    Track,
    {
      tier: number;
      lap?: number;
      cleared?: number;
      suspended?: {
        tier: number;
        phase: string;
        lap?: number;
        queue: string[];
      }[];
      phase: string;
      remaining: string[];
      rotation: string[];
      objectives: Objective[];
      topics: Record<string, string>;
      progress: string;
      curriculum: string;
    }
  >;
}
export interface Contract {
  kind?: "checkpoint" | "transfer" | "integration";
  id: string;
  track: Track;
  /** Legacy objectiveIds also carries track-qualified topic/integration IDs for final work. */
  objectiveIds: string[];
  scopes: string[];
  depth: number;
  phase: string;
  review: boolean;
  ledgerVersion: number;
  priorEvidence: string[];
  scheduleNote?: string;
  /** A variety question: probes and records knowledge, never the formal visit. */
  practice?: boolean;
  missingFacets?: string[];
  preservedFacets?: string[];
  historicalScope?: {
    sourceHash: string;
    gaps: {
      id: string;
      objectiveId: string;
      depth: number;
      kind: string;
      preserved: string;
      missing: string;
      evidenceRefs: string;
      status: string;
      nextCheck: string;
      revisit: string;
    }[];
    evidenceRows: string[];
  };
}
export interface StudyState {
  /** Free-form AI impressions; separate from verified curriculum credit. */
  topicAssessments?: Record<string, TopicAssessmentRecord>;
  roadmapReconciliations?: RoadmapReconciliationJob[];
  roadmapAdoptionBackups?: RoadmapAdoptionBackup[];
  environmentReviews?: EnvironmentReviewJob[];
  environmentObservations?: EnvironmentObservation[];
  roadmapExport?: RoadmapExport;
  /** Learner-declared gaps conceded in conversation; never mastery. */
  knowledgeGaps?: KnowledgeGapRecord[];
  /** Facets established in conversation (answered or implied); never mastery. */
  knowledgeEstablished?: KnowledgeEstablishedRecord[];
  profile?: "development" | "live";
  careerFocus?: CareerFocus;
  learner?: LearnerLedger;
  version: number;
  cycle: number;
  cycleOffset?: number;
  /** Completed human questions drive track balance separately from academic visits. */
  studyTurnPosition?: number;
  queues: Record<Track, string[]>;
  phases: Record<Track, string>;
  reviewsServed: string[];
  visits: { id: string; contract: Contract; encounter: string; at: string }[];
  pending?: { contract: Contract; encounter: string };
  session?: string;
  assessments: Assessment[];
  archives: Encounter[];
}
export interface Finding {
  objectiveId: string;
  facet: string;
  outcome: "independent" | "assisted" | "unknown" | "contradicted";
  /** How much help an assisted answer relied on: a hint, or the step itself. */
  assistance?: "hinted" | "given";
  depth?: number;
  execution?: "not-run" | "executed";
  evidence: number[];
  completeCheckpointScope: boolean;
  rationale: string;
}
export interface Assessment {
  /** Immutable provider request retained until an explicit retry succeeds. */
  request?: SavedRequest;
  historicalMappings?: HistoricalFacetMapping[];
  id: string;
  encounter: string;
  sourceVersion: number;
  findings: Finding[];
  status: "pending" | "review-required" | "applied";
  provenance: string;
  /** Whether a review-required assessment was only cut off (true: the relay
   * unreachable, the page closing) or refused (false). A cut-off one is sent
   * again by itself (src/resume-work.ts). Absent on loading's own restart
   * note and in earlier builds' saves, where the provenance tells. */
  resume?: boolean;
  evidenceCutoffSequence?: number;
  visitOutcome?: "usable" | "unresolved" | "invalid";
  scopeReviews?: {
    id: string;
    /** Whether the registered criteria cover the curriculum, not current learner mastery. */
    completeCoverage: boolean;
    rationale: string;
    definitionIssue?: {
      sourceHash: string;
      sourceQuote: string;
      missingCriterion: string;
    };
  }[];
  helpAttributions?: {
    messageId: string;
    facets: string[];
    rationale: string;
  }[];
}
export interface Artifact {
  executionId?: string;
  wallTime?: string;
  delta?: { prefix: number; removed: string; inserted: string };
  seq: number;
  author: string;
  kind:
    | "edit"
    | "reasoning"
    | "test"
    | "defense"
    | "npc-thought"
    | "npc-proposal"
    | "workspace-view"
    | "source-view"
    | "validation"
    | "activity"
    | "tutor"
    | "completion"
    | "starter"
    | "execution"
    | "chat";
  text: string;
  at: number;
  revision: number;
  refs?: string[];
  presented?: number;
}
export interface Message {
  /** A tutor reply's own declaration: facets it supplied help for, and facets it offered help on. */
  help?: DeclaredHelp;
  /** On a learner message sent with the hint button: the offered facets they accepted a hint on. */
  accepts?: string[];
  sourceRefs?: number[];
  requestId?: string;
  id: string;
  author: string;
  kind: "human" | "npc" | "tutor" | "system";
  text: string;
  seq: number;
  worldTime: number;
  presented?: number;
  provenance: string;
}
export interface Submission {
  dialogueRequestId?: string;
  /** The saved request of the retired answer check. Carried, never sent. */
  completionRequest?: SavedRequest;
  id: string;
  revision: number;
  author: string;
  content: string;
  status: "pending" | "complete" | "needs-work" | "error";
  feedback: string;
  seq: number;
}
export interface Problem {
  /** Generation-time seconds a learner who already has the skill needs for one
   * complete correct answer; pacing metadata only, nothing schedules from it. */
  estimatedSolveSeconds?: number;
  /** One estimate per part, in order (one entry for a question shown whole). */
  partSolveSeconds?: number[];
  runtime?: {
    language: "python" | "typescript";
    environment?: "react";
    steps?: BrowserStep[];
  };
  title: string;
  prompt: string;
  rubric: string[];
  starter: string;
  provenance: "development" | Provider;
  validation?: { kind: "trace"; answer: number };
  contract: Contract;
  scopeDefinitions?: ScopeDefinition[];
  /** A question worked one part at a time: the material every part shares
   * and each ask in order. `prompt` still holds the whole question. */
  staged?: { shared: string; parts: string[] };
}
export interface TutorRequest extends SavedRequest {
  id: string;
  questionSequence: number;
  state: "pending" | "interrupted" | "applied" | "superseded";
  error?: string;
  responseMessageId?: string;
  /** Whether an interrupted request was only cut off (true) or refused
   * (false). A cut-off one is sent again by itself (src/resume-work.ts).
   * Absent on loading's own restart note, which is read the same way. */
  resume?: boolean;
  /** Written by earlier builds, which resent a cut-off request only once. */
  resent?: boolean;
}
/** A question session the retired ChatGPT chat once ran. Saves still carry it,
 * so learning history reads it; nothing creates or continues one any more. */
export interface DirectStudySession extends SavedRequest {
  id: string;
  createdAt?: number;
  responseReceivedAt?: number;
  appliedAt?: number;
  questionFingerprint: string;
  state: "pending" | "interrupted" | "paused" | "applied" | "superseded";
  responseDigest?: string;
  error?: string;
  transportPhase?: string;
  transportPhaseAt?: number;
}
export interface Encounter {
  /** Standalone learning task started from the study workspace. */
  studyOnly?: boolean;
  /** Once-only human completion receipt for track balance. */
  studyTurnRecorded?: boolean;
  directStudy?: DirectStudySession;
  chatDraft?: string;
  tutorRequests?: TutorRequest[];
  /** For a question worked part by part: the last message of each part the
   * learner has left, in order. Its length is the index of the open part. */
  partsDone?: number[];
  /** The tutor message that confirmed the open part, while the learner has
   * not opened the next one yet. */
  partReady?: number;
  /** Knowledge probe: facets, per-turn findings and answer signals. */
  probe?: KnowledgeProbe;
  executions?: WorkspaceExecution[];
  runId?: string;
  problemPresentedSequence?: number;
  /** Wall-clock time the problem was first presented; orders topic assessments. */
  problemPresentedAt?: number;
  /** Short summaries of the questions the learner replaced here, newest
   * first, so a later regeneration does not return to one of them. Question
   * text only. */
  discardedQuestions?: { title: string; opening: string; asks: string[] }[];
  pendingGeneration?: {
    /** Legacy saved generation requests were always ChatGPT handoffs. */
    provider?: Provider;
    requestId: string;
    payload: Record<string, unknown>;
  };
  id: string;
  /** Saved records written before the study workspace may be shared or owned
   * by someone other than the learner; only the learner's own are worked. */
  mode: "solo" | "shared";
  state: "available" | "in-progress" | "submitted" | "consumed";
  owner?: string;
  problem?: Problem;
  workspace: string;
  workspaceBase?: string;
  revision: number;
  history: Artifact[];
  tutor: Message[];
  /** Team chat from before the study workspace; it remains evidence of the
   * help the learner received, so it is read but never written. */
  group?: Message[];
  submissions: Submission[];
  contributors: string[];
  accepted?: string;
  chatOpen: boolean;
  scroll: number;
  selection: [number, number];
  generation?: string;
  error?: string;
}
export interface Settings {
  /** Interface magnification; omitted by older saves (100%). */
  displayScale?: number;
  /** Saved by the retired ChatGPT worker settings; no longer read. */
  handoffAutonomous?: boolean;
}
/**
 * The saved record: the learner's study state, its questions and their
 * conversations, and the settings. Saves written by earlier builds hold more
 * fields (legacy simulation state). They are neither read nor validated and
 * are written back unchanged.
 */
export interface StudyRecord {
  /** The saved record format. */
  schema: 1;
  id: string;
  /** Orders every recorded question artifact and message. */
  seq: number;
  time: number;
  /** The workspace question view, selected and remembered across reloads. */
  studyWorkspace?: { enabled: boolean; encounter?: string };
  /** Last question actually opened by the human; stable across page reload. */
  lastStudyEncounter?: string;
  encounters: Record<string, Encounter>;
  study: StudyState;
  settings: Settings;
  notice: string;
}
/** Advance and return the record's sequence, which orders recorded artifacts. */
export function nextSeq(g: Pick<StudyRecord, "seq">) {
  return ++g.seq;
}
