/**
 * The lesson view: the two-pane screen a recorded gap opens into. On the left
 * a generated lesson to read, on the right a tutor chat that only answers
 * questions about it.
 *
 * Which lesson is open lives in memory only. The lesson body is mounted once
 * per lesson (`mountLesson` draws it from data) and never rebuilt by a repaint;
 * the status lines and the footer buttons are rewritten only when their
 * content changed, and the chat draws each message once and adds to itself.
 * Nothing here touches the
 * learner's saved record: reading a lesson, answering its checks and chatting
 * record nothing about knowing, so "Test me on this" only hands the gap to the
 * host.
 */
import { checkBridge, status } from "./ai";
import { $, setHtml, setNodeText, setText } from "./dom";
import { escapeHtml as escape } from "./html";
import { encounterGaps, type KnowledgeGapRecord } from "./knowledge-probe";
import { lessonGap, lessonOffer, openLessonGaps, type Lessons } from "./lesson";
import { mountLesson, type MountedLesson } from "./lesson-render";
import type { LessonDoc, LessonMessage } from "./lesson-types";
import { markdownToHtml } from "./markdown";
import type { Encounter, Roadmap, StudyRecord } from "./model";
import { messageBubble } from "./terminal-panels";

export interface LessonSurfaceHost {
  /** The current record: an import replaces it. */
  studyRecord(): StudyRecord;
  roadmap: Roadmap;
  lessons: Lessons;
  reducedMotion(): boolean;
  log(type: string, data?: unknown): void;
  /** The learner asked to be tested on this gap. On success the host closes
   * the lesson and returns nothing; otherwise it returns the reason, in plain
   * words, and the lesson stays open. */
  testGap(gap: KnowledgeGapRecord): string | undefined;
  /** Why this gap cannot be tested now, or nothing when it can. */
  canTest(gap: KnowledgeGapRecord): string | undefined;
  /** Whether an unfinished question exists. */
  questionOpen(): boolean;
}

const SUGGESTIONS = [
  "Explain it another way",
  "Give me another example",
  "Where would I use this in an interview?",
];
const TEST_BLOCKED =
  "Finish your open question first; then this gap can be tested.";
const STAYS_OPEN = "This gap stays open until a question shows you have it.";
const CLOSED = "This gap is closed. The lesson stays here to reread.";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function createLessonSurface(host: LessonSurfaceHost) {
  const { lessons } = host;
  const workspace = $("#study-workspace");
  const slot = $("#study-lesson-slot");
  const body = $("#lesson-body");
  const statusBox = $("#lesson-status");
  const layout = $("#lesson .terminal-layout");
  const messages = $("#lesson-messages");
  const chatStatus = $("#lesson-chat-status");
  const input = $<HTMLTextAreaElement>("#lesson-chat-input");
  const readButton = $<HTMLButtonElement>("#lesson-read");
  const testButton = $<HTMLButtonElement>("#lesson-test");
  const rewriteButton = $<HTMLButtonElement>("#lesson-rewrite");
  const footer = $("#lesson-footer");

  let openGap: string | undefined;
  /** Where focus returns when the lesson closes: the gap's button in the map's
   * list (by gap id, since the list is drawn again) or else the element that
   * had focus. */
  let openerGap: string | undefined;
  let opener: HTMLElement | undefined;
  /** What the learner had typed in each gap's chat box, kept while it is away. */
  const drafts = new Map<string, string>();
  /** Why "Test me on this" did not start, shown in the footer. */
  let testNote: string | undefined;
  /** The lesson drawn in the body: it is drawn again only when this changes. */
  let mounted:
    { gap: string; lesson: LessonDoc; view?: MountedLesson } | undefined;
  /** A second press on "Write a different lesson" confirms it. */
  let confirmRewrite = false;
  /** When each lesson request attempt was first seen pending, for the elapsed
   * time. An entry goes when its record leaves pending. */
  const started = new Map<string, number>();

  const gapRecord = (id: string | undefined) =>
    id
      ? host.studyRecord().study.knowledgeGaps?.find((gap) => gap.id === id)
      : undefined;

  function unmount() {
    mounted?.view?.destroy();
    mounted = undefined;
    body.textContent = "";
  }

  function generate(gap: KnowledgeGapRecord, fresh: boolean) {
    host.log("lesson-requested", { gap: gap.id, fresh });
    void lessons.generate(host.studyRecord(), host.roadmap, gap, { fresh });
  }

  /** Only a gap with no lesson record at all is written on opening; a failed
   * one waits for the learner's "Try again". */
  function ensureLesson(gap: KnowledgeGapRecord) {
    if (
      !lessons.record(gap.id) &&
      lessons.available() &&
      lessonOffer(host.studyRecord(), lessonGap(gap)).allowed
    )
      generate(gap, false);
  }

  const visible = (el: HTMLElement | null | undefined) =>
    el?.isConnected && el.getClientRects().length ? el : undefined;

  function keepDraft() {
    if (openGap === undefined) return;
    if (input.value) drafts.set(openGap, input.value);
    else drafts.delete(openGap);
  }

  function open(gapId: string, fromList = false) {
    const gap = gapRecord(gapId);
    if (!gap) return;
    if (openGap === undefined) {
      openerGap = fromList ? gapId : undefined;
      opener =
        !fromList && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
    }
    keepDraft();
    input.value = drafts.get(gapId) ?? "";
    openGap = gapId;
    confirmRewrite = false;
    testNote = undefined;
    workspace.dataset.lesson = "open";
    slot.hidden = false;
    host.log("lesson-opened", { gap: gap.id });
    ensureLesson(gap);
    render();
    $("#lesson-title").focus({ preventScroll: true });
  }

  function close() {
    if (openGap === undefined) return;
    const gap = openGap;
    keepDraft();
    openGap = undefined;
    testNote = undefined;
    unmount();
    delete workspace.dataset.lesson;
    slot.hidden = true;
    void lessons.flush();
    host.log("lesson-closed", { gap });
    // The list is drawn again first so its button for this gap exists.
    renderGapList();
    // The opener is gone when its list was redrawn (its label follows the
    // lesson): then this gap's button that can be seen, wherever it is. The
    // map's list comes first in the page but is often folded away.
    const button = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-lesson-gap="${CSS.escape(gap)}"]`,
        ),
      ].find((el) => visible(el));
    const back = openerGap
      ? (visible(
          gapList.querySelector<HTMLElement>(
            `[data-lesson-gap="${CSS.escape(openerGap)}"]`,
          ),
        ) ??
        visible($("#study-gaps-summary")) ??
        $("#study-next"))
      : (visible(opener) ?? visible(button()) ?? $("#study-next"));
    opener = undefined;
    openerGap = undefined;
    back.focus({ preventScroll: true });
  }

  // ---- The status lines ------------------------------------------------------

  function generatingHtml(rec: { lesson?: unknown }) {
    return `<div class="generation-progress lesson-generating"><div class="generation-bar" aria-hidden="true"><span></span></div><p>${
      rec.lesson
        ? "Claude is writing a different lesson. This one stays until the new one is ready."
        : "Claude is writing your lesson. This can take a few minutes. You can leave: it is saved when ready."
    }</p><p class="generation-elapsed" aria-hidden="true">Elapsed <strong class="lesson-elapsed"></strong></p></div>`;
  }

  /** The status region's content. Changes only when the situation does: the
   * elapsed clock is a separate text node, so a live region is not re-read
   * every second. */
  function statusHtml(
    gap: KnowledgeGapRecord,
    allowed: boolean,
    reason: string | undefined,
  ): string {
    const rec = lessons.record(gap.id);
    const parts: string[] = [];
    if (!allowed) return `<p>${escape(reason ?? "")}</p>`;
    if (!lessons.available() && !rec?.lesson)
      parts.push(
        status().mode === "claude-cli"
          ? "<p>Lessons need a newer study bridge. Restart the bridge, then try again.</p>"
          : "<p>Claude is not connected, so no lesson can be written. Connect it, then try again.</p>",
        '<button type="button" class="quiet" data-lesson-action="check">Check again</button>',
      );
    else if (rec?.state === "pending") parts.push(generatingHtml(rec));
    else if (rec && (rec.state === "failed" || rec.state === "interrupted"))
      parts.push(
        `<p>${escape(rec.error ?? "The lesson request was interrupted.")}</p>`,
        ...(rec.lesson
          ? [
              '<p class="muted">The earlier lesson is still shown. The tutor is available again once a lesson request succeeds: press Try again.</p>',
            ]
          : []),
        '<button type="button" class="quiet" data-lesson-action="retry">Try again</button>',
      );
    if (rec?.state === "ready" && rec.dropped?.length) {
      const n = rec.dropped.length;
      parts.push(
        `<p class="muted">${n} ${plural(n, "figure", "figures")} could not be shown and ${plural(n, "was", "were")} left out.</p>`,
      );
    }
    const loadError = lessons.loadError();
    if (loadError) parts.push(`<p class="muted">${escape(loadError)}</p>`);
    const saveError = rec ? lessons.saveError(rec.key) : "";
    if (saveError && saveError !== loadError)
      parts.push(`<p class="muted">${escape(saveError)}</p>`);
    return parts.join("");
  }

  function renderStatus(
    gap: KnowledgeGapRecord,
    allowed: boolean,
    reason?: string,
  ) {
    const rec = lessons.record(gap.id);
    setHtml(statusBox, statusHtml(gap, allowed, reason));
    statusBox.hidden = statusBox.childElementCount === 0;
    const elapsed = statusBox.querySelector(".lesson-elapsed");
    if (!rec) return;
    const clockKey = `${rec.requestId}:${rec.attempt}`;
    if (rec.state !== "pending") started.delete(clockKey);
    else if (elapsed) {
      if (!started.has(clockKey)) started.set(clockKey, Date.now());
      setNodeText(elapsed, clock(Date.now() - started.get(clockKey)!));
    }
  }

  // ---- The lesson body ------------------------------------------------------

  function renderBody(gap: KnowledgeGapRecord) {
    const rec = lessons.record(gap.id);
    const lesson = rec?.lesson;
    if (!lesson) {
      if (mounted) unmount();
      return;
    }
    if (mounted && mounted.gap === gap.id && mounted.lesson === lesson) return;
    unmount();
    mounted = { gap: gap.id, lesson };
    try {
      mounted.view = mountLesson(body, lesson, {
        responses: rec.responses,
        onResponse: (blockKey, value) =>
          lessons.setResponse(gap.id, blockKey, value),
        reducedMotion: host.reducedMotion,
      });
    } catch (error) {
      // The lesson stays in the status line as a failure of drawing it; it is
      // not drawn again until it changes.
      host.log("lesson-draw-failed", {
        gap: gap.id,
        message: String(error instanceof Error ? error.message : error).slice(
          0,
          200,
        ),
      });
      body.textContent = "";
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent =
        "This lesson could not be shown. Write a different lesson.";
      body.append(note);
    }
  }

  function renderFooter(gap: KnowledgeGapRecord, allowed: boolean) {
    const rec = lessons.record(gap.id);
    const has = !!rec?.lesson;
    footer.hidden = !has;
    if (!has) return;
    const closed = !!gap.resolved;
    const why = closed
      ? undefined
      : host.questionOpen()
        ? TEST_BLOCKED
        : host.canTest(gap);
    const note = [
      closed ? CLOSED : STAYS_OPEN,
      why,
      !closed && testNote !== why ? testNote : undefined,
    ];
    setText("#lesson-footer-note", note.filter(Boolean).join(" "));
    const read = !!rec.readAt;
    readButton.classList.toggle("is-read", read);
    readButton.setAttribute("aria-disabled", String(read));
    setNodeText(readButton, read ? "Read" : "Done reading");
    testButton.hidden = !allowed || closed || why !== undefined;
    rewriteButton.hidden = rec.state === "pending";
    setNodeText(
      rewriteButton,
      confirmRewrite ? "Replace this lesson?" : "Write a different lesson",
    );
  }

  // ---- The tutor chat ----------------------------------------------------------

  /** The chat's nodes, drawn once per message and kept: a streamed reply only
   * rewrites its own bubble, so focus, selection and the scroll position
   * elsewhere in the chat survive, and markdown runs once per message. */
  const chat = {
    /** The gap whose chat is drawn; another one starts from empty. */
    gap: undefined as string | undefined,
    messages: new Map<
      string,
      Pick<LessonMessage, "role" | "text" | "section"> & {
        title?: string;
        nodes: ChildNode[];
      }
    >(),
    /** The newest message drawn, to see when the learner just sent one. */
    last: undefined as string | undefined,
    typing: undefined as { text: string; node: HTMLElement } | undefined,
    suggestions: undefined as ChildNode | undefined,
  };

  const parse = (html: string) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    return [...template.content.childNodes];
  };

  /** A message's bubble and, under a tutor reply that points at a section,
   * the button that shows it. `title` is that section's title. */
  function messageMarkup(m: LessonMessage, title: string | undefined) {
    if (m.role === "learner") return messageBubble("human", "You", m.text);
    return (
      messageBubble("tutor", "Tutor", m.text) +
      (m.section && title !== undefined
        ? `<button type="button" class="quiet lesson-show" data-lesson-show="${escape(m.section)}">Show: ${escape(title)}</button>`
        : "")
    );
  }

  /** The reply being streamed: one bubble whose body alone is rewritten. */
  function typingNode(text: string) {
    if (!chat.typing) {
      const [node] = parse(messageBubble("tutor", "Tutor", ""));
      chat.typing = { text: "", node: node as HTMLElement };
    }
    if (chat.typing.text !== text) {
      chat.typing.text = text;
      chat.typing.node.querySelector(".message-body")!.innerHTML =
        markdownToHtml(text);
    }
    return chat.typing.node;
  }

  function suggestionsNode() {
    chat.suggestions ??= parse(
      `<div class="lesson-suggestions">${SUGGESTIONS.map(
        (text, i) =>
          `<button type="button" class="quiet" data-lesson-suggest="${i}">${escape(text)}</button>`,
      ).join("")}</div>`,
    )[0];
    return chat.suggestions;
  }

  /** Puts exactly `wanted` in the chat, in order, moving no node that is
   * already in place. Says whether anything changed. */
  function placeChat(wanted: ChildNode[]) {
    const keep = new Set(wanted);
    let changed = false;
    for (const node of [...messages.childNodes])
      if (!keep.has(node)) {
        node.remove();
        changed = true;
      }
    wanted.forEach((node, i) => {
      const at = messages.childNodes[i] ?? null;
      if (at === node) return;
      messages.insertBefore(node, at);
      changed = true;
    });
    return changed;
  }

  function renderChat(gap: KnowledgeGapRecord, lesson: LessonDoc | undefined) {
    const rec = lessons.record(gap.id);
    if (!rec || !lesson) return;
    const fresh = chat.gap !== gap.id;
    if (fresh) {
      chat.gap = gap.id;
      chat.messages.clear();
      chat.last = undefined;
    }
    const titles = new Map(lesson.sections.map((s) => [s.id, s.title]));
    const typing = lessons.streaming(gap.id);
    const busy = rec.chat.some((m) => m.state === "pending");
    const wanted: ChildNode[] = [];
    const ids = new Set<string>();
    for (const m of rec.chat) {
      ids.add(m.id);
      // Drawn again only when something its markup shows has changed.
      const title = m.section ? titles.get(m.section) : undefined;
      let drawn = chat.messages.get(m.id);
      if (
        !drawn ||
        drawn.role !== m.role ||
        drawn.text !== m.text ||
        drawn.section !== m.section ||
        drawn.title !== title
      ) {
        drawn = {
          role: m.role,
          text: m.text,
          section: m.section,
          title,
          nodes: parse(messageMarkup(m, title)),
        };
        chat.messages.set(m.id, drawn);
      }
      wanted.push(...drawn.nodes);
    }
    // Messages trimmed away or cleared by a new lesson are let go.
    for (const id of chat.messages.keys())
      if (!ids.has(id)) chat.messages.delete(id);
    if (busy && typing) wanted.push(typingNode(typing));
    if (!rec.chat.length && rec.state === "ready")
      wanted.push(suggestionsNode());
    const atBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 8;
    const newest = rec.chat[rec.chat.length - 1];
    const justSent = newest?.role === "learner" && newest.id !== chat.last;
    chat.last = newest?.id;
    // Follow the conversation unless the learner has scrolled up to reread.
    if (placeChat(wanted) && (fresh || atBottom || justSent))
      messages.scrollTop = messages.scrollHeight;
    const failed = newest?.role === "learner" && newest.state === "failed";
    setHtml(
      chatStatus,
      failed
        ? `<p>${escape(newest.error ?? "The reply did not arrive.")}</p><button type="button" class="quiet" data-lesson-action="chat-retry">Try again</button>`
        : busy && !typing
          ? "<p>Waiting for a reply.</p>"
          : rec.state !== "ready"
            ? "<p>The tutor is available when the lesson is ready.</p>"
            : "",
    );
    chatStatus.hidden = chatStatus.childElementCount === 0;
    input.disabled = rec.state !== "ready";
  }

  /** Sends a chat message. Says at once whether it was started; `rejected` is
   * called if the lesson then refuses it. */
  function send(text: string, rejected?: () => void) {
    const gap = openGap;
    if (!gap) return false;
    const rec = lessons.record(gap);
    if (!text.trim() || rec?.state !== "ready") return false;
    if (rec.chat.some((m) => m.state === "pending")) return false;
    host.log("lesson-message", { gap, chars: text.length });
    void lessons.send(gap, text).then((accepted) => {
      if (!accepted) rejected?.();
    });
    return true;
  }

  // ---- Render --------------------------------------------------------------------

  function render() {
    if (openGap === undefined) return;
    const gap = gapRecord(openGap);
    // A replaced record may no longer hold the gap that was open.
    if (!gap) return close();
    const { allowed, reason } = lessonOffer(host.studyRecord(), lessonGap(gap));
    // A lesson opened while lessons were unavailable is written once they are.
    if (allowed) ensureLesson(gap);
    if (openGap === undefined) return;
    const rec = lessons.record(gap.id);
    const lesson = allowed ? rec?.lesson : undefined;
    setText("#lesson-title", lesson?.title ?? gap.facet.description);
    renderStatus(gap, allowed, reason);
    layout.hidden = !lesson;
    if (lesson) renderBody(gap);
    else if (mounted) unmount();
    renderFooter(gap, allowed);
    renderChat(gap, lesson);
  }

  // ---- Controls --------------------------------------------------------------------

  $("#lesson-close").onclick = () => close();
  readButton.onclick = () => {
    if (openGap !== undefined) lessons.markRead(openGap);
  };
  testButton.onclick = () => {
    const gap = gapRecord(openGap);
    if (!gap) return;
    const why = host.testGap(gap);
    if (why === undefined || openGap !== gap.id) return;
    testNote = why;
    render();
  };
  rewriteButton.onclick = () => {
    const gap = gapRecord(openGap);
    if (!gap) return;
    if (!confirmRewrite) {
      confirmRewrite = true;
      return render();
    }
    confirmRewrite = false;
    generate(gap, true);
    render();
    $("#lesson-title").focus({ preventScroll: true });
  };
  statusBox.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-lesson-action]",
    );
    const gap = gapRecord(openGap);
    if (!button || !gap) return;
    if (button.dataset.lessonAction === "retry") {
      generate(gap, true);
      render();
      $("#lesson-title").focus({ preventScroll: true });
    } else if (button.dataset.lessonAction === "check")
      void checkBridge().then(() => {
        if (openGap === gap.id) ensureLesson(gap);
        render();
      });
  });
  chatStatus.addEventListener("click", (event) => {
    const button = (event.target as Element).closest("[data-lesson-action]");
    if (!button || openGap === undefined) return;
    void lessons.retryChat(openGap);
    // The button goes once the retry starts; the learner's next move is here.
    input.focus({ preventScroll: true });
  });
  messages.addEventListener("click", (event) => {
    const target = event.target as Element;
    const suggest = target.closest<HTMLElement>("[data-lesson-suggest]");
    if (suggest) {
      const text = SUGGESTIONS[Number(suggest.dataset.lessonSuggest)] ?? "";
      if (send(text)) input.focus({ preventScroll: true });
      return;
    }
    const show = target.closest<HTMLElement>("[data-lesson-show]");
    if (show?.dataset.lessonShow)
      mounted?.view?.scrollToSection(show.dataset.lessonShow);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $<HTMLFormElement>("#lesson-chat-form").requestSubmit();
    }
  });
  $("#lesson-chat-form").onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value;
    const gap = openGap;
    const sent = send(text, () => {
      // Not accepted: the text goes back, unless something else was typed.
      if (gap === openGap && !input.value) input.value = text;
      else if (gap !== undefined && gap !== openGap && !drafts.has(gap))
        drafts.set(gap, text);
    });
    if (sent) input.value = "";
  };

  // ---- Entry points: the question's offers and the map's list ------------------

  const offers = $("#lesson-offers");
  const gapList = $("#study-gaps-list");
  const label = (gapId: string) => {
    const rec = lessons.record(gapId);
    return rec?.state === "pending" && !rec.lesson
      ? "Lesson in progress"
      : rec?.lesson
        ? "Open lesson"
        : "Learn this";
  };
  const learnButton = (gapId: string) =>
    `<button type="button" class="quiet" data-lesson-gap="${escape(gapId)}">${label(gapId)}</button>`;
  const onEntry = (event: Event, fromList: boolean) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-lesson-gap]",
    );
    if (button?.dataset.lessonGap) open(button.dataset.lessonGap, fromList);
  };
  offers.addEventListener("click", (event) => onEntry(event, false));
  gapList.addEventListener("click", (event) => onEntry(event, true));

  /** Writes a list of lesson buttons. A button's label changes as its lesson
   * is written, and the rewrite replaces the node: keep focus on that gap. */
  function writeButtons(box: HTMLElement, html: string) {
    const held = document.activeElement;
    const gap =
      held instanceof HTMLElement && box.contains(held)
        ? held.dataset.lessonGap
        : undefined;
    if (!setHtml(box, html) || gap === undefined) return;
    box
      .querySelector<HTMLElement>(`[data-lesson-gap="${CSS.escape(gap)}"]`)
      ?.focus({ preventScroll: true });
  }

  /** Under a finished question: its recorded gaps that are still open. */
  function renderOffers(e: Encounter | undefined) {
    const gaps =
      e && e.state === "consumed"
        ? encounterGaps(host.studyRecord(), e).filter((gap) => !gap.resolved)
        : [];
    offers.hidden = !gaps.length;
    writeButtons(
      offers,
      gaps
        .map(
          (gap) =>
            `<div class="lesson-offer"><span>${escape(gap.facet.description)}</span>${learnButton(gap.id)}</div>`,
        )
        .join(""),
    );
  }

  /** On the map: every open gap, newest first. */
  function renderGapList() {
    const box = $<HTMLDetailsElement>("#study-gaps");
    const gaps =
      openGap === undefined ? openLessonGaps(host.studyRecord()) : [];
    box.hidden = !gaps.length;
    setText("#study-gaps-summary", `Gaps to study (${gaps.length})`);
    writeButtons(
      gapList,
      gaps
        .map(
          (gap) =>
            `<li><span>${escape(gap.facet.description)}${
              lessons.record(gap.id)?.readAt
                ? ' <span class="lesson-badge">Lesson read</span>'
                : ""
            }</span>${learnButton(gap.id)}</li>`,
        )
        .join(""),
    );
  }

  return {
    open,
    close,
    isOpen: () => openGap !== undefined,
    render,
    renderOffers,
    renderGapList,
  };
}

export type LessonSurface = ReturnType<typeof createLessonSurface>;
