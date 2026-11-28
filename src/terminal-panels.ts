/**
 * The parts of the open terminal that the study workspace shows: where the
 * question came from, the status line above the conversation, saved-request
 * status and the conversation itself.
 *
 * Each panel is rendered from the encounter it is given and only touches the
 * DOM when its content changed, because the terminal re-renders on every UI
 * tick and a rewrite would clear a selection the learner is making.
 */
import { retryTutorRequest, streamingReply } from "./ai";
import { $, setHtml } from "./dom";
import { escapeHtml as escape } from "./html";
import { encounterGaps, gapsClosedBy, probeSummary } from "./knowledge-probe";
import { encounterKey } from "./learner";
import { markdownToHtml } from "./markdown";
import { advancePart, nextPartOffer, partMarkers } from "./question-parts";
import { supersedeInterrupted } from "./run-learning";
import type { Encounter, StudyRecord, Roadmap } from "./model";

/** What the question's conversation partner is called. */
const TUTOR = "Tutor";
/** Every saved reply carries this stored speaker name. */
export const speakerLabel = (author: string) =>
  author === "Terminal AI" ? TUTOR : author;

/** Rendered bubbles by kind, name and text. The conversation is rebuilt on
 * every UI tick, and parsing each message's markdown again is the costly part
 * of that; a bubble is a pure function of these three strings. */
const bubbles = new Map<string, string>();
const BUBBLE_CACHE_LIMIT = 500;

/** One chat bubble: the speaker's name as plain text and the message as
 * markdown, which markdownToHtml escapes. Shared by the question's
 * conversation and the lesson's tutor chat. */
export function messageBubble(kind: string, name: string, text: string) {
  const key = `${kind}\u0000${name}\u0000${text}`;
  let html = bubbles.get(key);
  if (html === undefined) {
    html = `<div class="message ${escape(kind)}"><strong>${escape(name)}</strong><div class="message-body">${markdownToHtml(text)}</div></div>`;
    if (bubbles.size >= BUBBLE_CACHE_LIMIT) bubbles.clear();
    bubbles.set(key, html);
  }
  return html;
}

interface TerminalPanelHost {
  /** The current record: an import replaces it. */
  studyRecord(): StudyRecord;
  roadmap: Roadmap;
  /** The question open in the terminal, looked up when a button is used. */
  openEncounter(): Encounter | undefined;
  persist(): unknown;
  /** Re-render whichever terminal is open. */
  render(): void;
  /** Save and re-render when a started request settles; show its failure. */
  settle(pending: Promise<unknown>, e: Encounter): void;
}

/** Where a terminal's question came from and how it relates to earlier work. */
export function provenanceText(studyRecord: StudyRecord, e: Encounter): string {
  let text =
    e.problem?.provenance === "claude-cli"
      ? "Claude CLI"
      : e.problem?.provenance === "chatgpt-handoff"
        ? "ChatGPT handoff · Saved provider provenance"
        : e.problem?.provenance === "study-mode"
          ? "Study bridge · Saved provider provenance"
          : !e.problem && studyRecord.study.profile === "live"
            ? "Live study request · Awaiting a validated problem"
            : "Earlier practice question · No academic credit";
  if (e.problem?.contract.practice)
    text +=
      " · Practice question: what you show here is recorded and can close a gap, but this is not a scheduled visit and gives no credit";
  if (
    studyRecord.study.learner?.attempts.some(
      (a) =>
        a.encounter === encounterKey(e) && a.status === "externally-resolved",
    )
  )
    text +=
      " · Resolved in your imported roadmap. Your original question and draft remain open; finishing it does not start another academic visit.";
  return text;
}

/** The line above a solo conversation: its outcome, or how the probe stands. */
export function dialogueStatus(studyRecord: StudyRecord, e: Encounter) {
  // "Last answer partial" describes how an answer was given while the
  // question is open. Beside a final "Solved" it reads as a second verdict,
  // and later discussion never updates it, so a finished question omits it.
  const probeLine = probeSummary(e, { signal: e.state !== "consumed" });
  const recorded = encounterGaps(studyRecord, e);
  const conceded = recorded.filter((r) => !r.resolved);
  const closed = recorded.length - conceded.length;
  const text =
    e.state === "consumed"
      ? `${
          conceded.length
            ? `Solved with a recorded gap. Recorded for later study: ${conceded.map((r) => r.facet.description).join("; ")}.`
            : closed
              ? `Solved. ${closed === 1 ? "The recorded gap was" : `${closed} recorded gaps were`} closed later.`
              : "Solved."
        } You can keep discussing the question.${probeLine ? ` ${probeLine}.` : ""}`
      : probeLine
        ? `Knowledge probe · ${probeLine}. Say so if you do not know something; the gap is recorded.`
        : "Work through the question with your tutor. Your answers stay in this conversation.";
  return { hidden: e.state !== "consumed" && !probeLine, text };
}

/** How many messages precede the "question complete" marker: those up to the
 * reply that finished it, so later discussion follows the marker. Undefined
 * while the question is unfinished. */
export function completionMarkerIndex(e: Encounter): number | undefined {
  if (e.state !== "consumed") return undefined;
  const accepted = e.submissions.find((s) => s.id === e.accepted);
  if (!accepted) return e.tutor.length;
  let index = 0;
  while (index < e.tutor.length && e.tutor[index].seq < accepted.seq) index++;
  return index;
}
const COMPLETION_MARKER =
  '<div class="message-complete"><strong>✓ Question complete</strong><span>Your result is saved. You can keep discussing it here, or open the Skill map for the next question.</span></div>';

/** The notice under a reply that closed a gap recorded at this question. */
export function gapClosedMarker(
  studyRecord: StudyRecord,
  e: Encounter,
  m: Encounter["tutor"][number],
): string {
  if (m.kind !== "tutor") return "";
  const closed = gapsClosedBy(studyRecord, e, m.requestId);
  return closed.length
    ? `<div class="message-complete gap-closed"><strong>✓ Gap closed</strong><span>${escape(
        closed.map((r) => r.facet.description).join("; "),
      )}. Saved: this is no longer a study target.</span></div>`
    : "";
}

export function createTerminalPanels(host: TerminalPanelHost) {
  const { roadmap } = host;
  const statusBox = $("#tutor-request-status");
  const conversation = $("#messages");
  const announcer = $("#tutor-announce");
  // The buttons below are bound once and act on the question open when they
  // are used: unchanged markup is not rewritten, so a handler bound at render
  // time could outlive the question it was written for (after an import).
  statusBox.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-question-retry]")
        : null;
    const e = host.openEncounter();
    if (!button || !e) return;
    host.settle(
      retryTutorRequest(
        host.studyRecord(),
        e,
        button.dataset.questionRetry!,
        roadmap,
      ),
      e,
    );
    host.persist();
    host.render();
  });
  conversation.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest("[data-next-part]")
        : null;
    const e = host.openEncounter();
    if (!button || !e || !advancePart(e)) return;
    // A request interrupted on the part just left is not retried on the next.
    supersedeInterrupted(e);
    delete e.error;
    host.persist();
    host.render();
    $<HTMLTextAreaElement>("#chat-input").focus();
  });

  /** Saved questions that are waiting or were interrupted. */
  function requestStatus(e: Encounter) {
    const box = statusBox;
    const saved = e.tutorRequests ?? [];
    const open = saved.filter(
      (j) => j.state !== "applied" && j.state !== "superseded",
    );
    // An error that belongs to a saved request is not repeated on its own.
    const chatError =
      e.error && !saved.some((j) => j.error === e.error) ? e.error : undefined;
    box.hidden = !chatError && !open.length;
    const html =
      (chatError ? `<p>${escape(chatError)}</p>` : "") +
      open
        .map(
          (j) =>
            `<p>${
              j.state === "pending"
                ? "Waiting for a reply."
                : escape(j.error ?? "Saved question interrupted.")
            }${j.state === "interrupted" ? `<button class="quiet" data-question-retry="${escape(j.id)}">Retry saved question</button>` : ""}</p>`,
        )
        .join("");
    setHtml(box, html);
  }

  // What the conversation last showed, so that it follows new messages
  // without pulling a learner who scrolled up back down, and announces a
  // reply once instead of re-reading the whole conversation.
  let shownEncounter: string | undefined;
  let shownMessages = 0;
  // The opening render can land while the question view is still hidden,
  // where setting scrollTop does nothing; the scroll is kept until it shows.
  let scrollPending = false;

  /** The conversation, then a reply still arriving. */
  function messages(e: Encounter) {
    const said = (m: Encounter["tutor"][number]) =>
      messageBubble(
        m.kind,
        m.author === "human" ? "You" : speakerLabel(m.author),
        m.text,
      );
    const done = completionMarkerIndex(e);
    const parts = partMarkers(e);
    const pending = (e.tutorRequests ?? []).some((j) => j.state === "pending");
    const html =
      e.tutor
        .map(
          (m, i) =>
            (i === done ? COMPLETION_MARKER : "") +
            said(m) +
            gapClosedMarker(host.studyRecord(), e, m) +
            (parts.get(m.seq) ?? ""),
        )
        .join("") +
      (pending ? "" : nextPartOffer(e)) +
      (done === e.tutor.length ? COMPLETION_MARKER : "") +
      (e.tutorRequests ?? [])
        .map((j) => (j.state === "pending" ? streamingReply(j) : undefined))
        .filter((text): text is string => !!text)
        .map((text) => messageBubble("tutor", TUTOR, text))
        .join("");
    const box = conversation;
    const opened = e.id !== shownEncounter;
    const added = opened ? [] : e.tutor.slice(shownMessages);
    shownEncounter = e.id;
    shownMessages = e.tutor.length;
    const stick =
      opened ||
      added.some((m) => m.author === "human") ||
      box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (added.some((m) => m.kind === "tutor")) announce("Tutor replied.");
    if (setHtml(box, html) && stick) scrollPending = true;
    if (scrollPending && box.clientHeight > 0) {
      box.scrollTop = box.scrollHeight;
      scrollPending = false;
    }
  }

  /** Says a short line to assistive technology once. The conversation itself
   * is rewritten as a reply streams, so it is not a live region. */
  function announce(text: string) {
    announcer.textContent = "";
    // A changed text is what a live region announces; clearing first lets the
    // same line be announced again for the next reply.
    requestAnimationFrame(() => {
      announcer.textContent = text;
    });
  }

  /** Forget what the conversation showed: the terminal closed, so the next
   * render is an opening (it scrolls to the latest message, announces
   * nothing) even when the same question, or an imported record reusing its
   * id, opens again. */
  function reset() {
    shownEncounter = undefined;
    shownMessages = 0;
    scrollPending = false;
  }

  return { requestStatus, messages, reset };
}
