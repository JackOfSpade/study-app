/**
 * Gap lessons: the controller. No DOM.
 *
 * A lesson teaches one recorded knowledge gap. It is read-only with respect to
 * the learner's saved record: this module READS the study record to choose gaps
 * and to build the request, and never writes it. Reading a lesson, answering
 * its checks and chatting beside it are not evidence of mastery and close no
 * gap; a gap closes only when a question shows the learner has it. Lessons,
 * their chat and read-state live in the separate lesson database
 * (`lesson-store.ts`). Lesson text and chat are never sent into question
 * generation, assessment or tutor requests.
 */
import {
  LESSON_CHAT_POLICY,
  LESSON_POLICY,
} from "../scripts/lib/lesson-policy.mjs";
import {
  LESSON_ID,
  LESSON_LIMITS,
  lessonPlainText,
  normalizeLesson,
} from "../scripts/lib/lesson-schema.mjs";
import { isInterruption, type bridgeRequest } from "./bridge-client";
import { encounterKey } from "./learner";
import { scopeKey } from "./learning-model";
import type { KnowledgeGapRecord } from "./knowledge-probe";
import {
  LESSON_STORE_LIMITS,
  type LessonEntry,
  type LessonStore,
} from "./lesson-store";
import type { LessonGap, LessonMessage } from "./lesson-types";
import { allEncounters, type Roadmap, type StudyRecord } from "./model";
import { isRecord } from "./records";

const SAVE_DELAY_MS = 400;
/** The longest message the learner can send the tutor. */
const MESSAGE_CHARS = 4000;
/** A saved answer's key, `<sectionId>/<index>` (see `lessonBlockKey`). */
const BLOCK_KEY = new RegExp(
  `^(${LESSON_ID.source.slice(1, -1)})\\/(\\d{1,3})$`,
);

/** What a lesson needs to know about a recorded gap. */
export function lessonGap(gap: KnowledgeGapRecord): LessonGap {
  return {
    id: gap.id,
    track: gap.track,
    objectiveIds: [...gap.objectiveIds],
    depth: gap.depth,
    facet: { id: gap.facet.id, description: gap.facet.description },
    ...(gap.partOf
      ? { partOf: { id: gap.partOf.id, description: gap.partOf.description } }
      : {}),
    statement: gap.statement,
    resolved: !!gap.resolved,
  };
}

/** Unresolved gaps, newest first. A gap recorded again for the same facet,
 * depth and objectives is listed once, as its newest record. */
export function openLessonGaps(g: StudyRecord): LessonGap[] {
  const all = g.study.knowledgeGaps ?? [];
  const newest = all
    .map((gap, index) => ({ gap, index }))
    .filter(({ gap }) => !gap.resolved)
    .sort(
      (a, b) =>
        (a.gap.at < b.gap.at ? 1 : a.gap.at > b.gap.at ? -1 : 0) ||
        b.index - a.index,
    );
  const seen = new Set<string>();
  const out: LessonGap[] = [];
  for (const { gap } of newest) {
    const same = JSON.stringify([
      gap.facet.description,
      gap.depth,
      [...gap.objectiveIds].sort(),
    ]);
    if (seen.has(same)) continue;
    seen.add(same);
    out.push(lessonGap(gap));
  }
  return out;
}

/** The objective ids of a saved, untrusted contract, or undefined. */
function pendingObjectives(contract: unknown): string[] | undefined {
  if (!isRecord(contract) || !Array.isArray(contract.objectiveIds))
    return undefined;
  const ids = contract.objectiveIds;
  return ids.every((id) => typeof id === "string")
    ? (ids as string[])
    : undefined;
}

/** A lesson is not offered while an unfinished question covers the same
 * objectives: it would give part of that question away. */
export function lessonOffer(
  g: StudyRecord,
  gap: LessonGap,
): { allowed: boolean; reason?: string } {
  const ids = new Set(gap.objectiveIds);
  const open = Object.values(g.encounters).some((e) => {
    if (e.state === "consumed") return false;
    if (e.problem?.contract?.objectiveIds?.some((id) => ids.has(id)))
      return true;
    // A question still being written counts too. Its saved contract is an
    // untrusted record; with none readable the topic is unknown, so be safe.
    const written = pendingObjectives(e.pendingGeneration?.payload?.contract);
    if (written) return written.some((id) => ids.has(id));
    return !!(e.generation || e.pendingGeneration);
  });
  return open
    ? {
        allowed: false,
        reason:
          "Finish the open question on this topic first. A lesson would give away part of it.",
      }
    : { allowed: true };
}

/** The request for one lesson. It holds the gap, the scope and the question
 * that recorded the gap; it holds no tutor message, no learner answer other
 * than the gap's own statement, and nothing from another lesson. */
export function lessonPayload(
  g: StudyRecord,
  r: Roadmap,
  gap: KnowledgeGapRecord,
  requestId: string,
  previousTitle?: string,
): object {
  const scope = gap.objectiveIds.length
    ? g.study.learner?.scopes?.[scopeKey(gap.objectiveIds[0], gap.depth)]
    : undefined;
  const source = allEncounters(g).find(
    (e) =>
      e.problem &&
      (encounterKey(e) === gap.encounter ||
        `${e.runId ?? g.id}/${e.id}` === gap.encounter),
  );
  return {
    requestId,
    gapId: gap.id,
    gap: {
      track: gap.track,
      objectiveIds: [...gap.objectiveIds],
      depth: gap.depth,
      facet: { id: gap.facet.id, description: gap.facet.description },
      ...(gap.partOf
        ? {
            partOf: {
              id: gap.partOf.id,
              description: gap.partOf.description,
            },
          }
        : {}),
      statement: gap.statement.slice(0, 400),
    },
    ...(scope ? { scope: structuredClone(scope) } : {}),
    ...(source?.problem
      ? {
          diagnostic: {
            title: source.problem.title,
            prompt: source.problem.prompt.slice(0, 1200),
          },
        }
      : {}),
    ...(previousTitle ? { previousTitle } : {}),
    lessonPolicy: LESSON_POLICY,
    curriculum: r.tracks[gap.track as keyof Roadmap["tracks"]].curriculum,
  };
}

export interface LessonHost {
  store: LessonStore;
  request: typeof bridgeRequest;
  capabilities(): string[];
  now?(): string;
  onChange?(): void;
}

const shortId = () => crypto.randomUUID().slice(0, 8);
/** A short plain reason, without an error class or a stack. */
function plain(error: unknown, lead: string) {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw
    .replace(/^(\w*Error):\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return text ? `${lead}: ${text}` : `${lead}.`;
}

/** A lesson or reply a reload or a lost relay cut off; it is sent again by
 * itself once Claude can be reached. Earlier builds wrote the first and the
 * second of these, so they are read the same way. */
const LESSON_CUT_OFF =
  "The page closed before this lesson arrived. It is requested again automatically.";
const PAGE_CLOSED_REPLY = "The page closed before the reply arrived.";
const CUT_OFF_REPLY =
  "The connection was lost before the reply arrived. It is sent again automatically.";
const cutOff = (m: LessonMessage) =>
  m.error === PAGE_CLOSED_REPLY || m.error === CUT_OFF_REPLY;

export function createLessons(host: LessonHost) {
  const records = new Map<string, LessonEntry>();
  const streams = new Map<string, string>();
  const generating = new Set<string>();
  const chatting = new Set<string>();
  const focusOf = new Map<string, string>();
  const saveNotes = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let loadProblem = "";
  let writes: Promise<void> = Promise.resolve();
  const now = () => host.now?.() ?? new Date().toISOString();

  /** Display callbacks are never allowed to cost the learner their lesson. */
  function changed() {
    try {
      host.onChange?.();
    } catch {
      // A failed repaint changes nothing that was saved.
    }
  }

  /** Queues a write of the record as it is now. Never rejects and never
   * touches anything but the lesson database. */
  function queueSave(rec: LessonEntry): Promise<void> {
    if (loadProblem) {
      saveNotes.set(
        rec.key,
        "Lessons could not be read, so this one is not being saved.",
      );
      return writes;
    }
    const clear = timers.get(rec.key);
    if (clear !== undefined) {
      clearTimeout(clear);
      timers.delete(rec.key);
    }
    let snapshot: LessonEntry;
    try {
      snapshot = structuredClone(rec);
    } catch (error) {
      saveNotes.set(rec.key, plain(error, "This lesson could not be saved"));
      return writes;
    }
    writes = writes
      .then(() => host.store.put(snapshot))
      .then(
        () => void saveNotes.delete(rec.key),
        (error) =>
          void saveNotes.set(
            rec.key,
            plain(error, "This lesson could not be saved"),
          ),
      );
    return writes;
  }

  const chatBusy = (rec: LessonEntry) =>
    chatting.has(rec.key) || rec.chat.some((m) => m.state === "pending");

  function trimChat(rec: LessonEntry) {
    if (rec.chat.length > LESSON_STORE_LIMITS.chat)
      rec.chat = rec.chat.slice(-LESSON_STORE_LIMITS.chat);
  }

  /** True when the request was started, whatever its outcome. */
  async function runChat(
    rec: LessonEntry,
    message: LessonMessage,
    /** A message that was only cut off goes again under its own request id,
     * so it joins the call still running or gets its kept answer. */
    resend = false,
  ): Promise<boolean> {
    const lesson = rec.lesson;
    if (!lesson) return false;
    const key = rec.key;
    const sectionIds = lesson.sections.map((s) => s.id);
    const focus = focusOf.get(message.id);
    if (!resend || rec.chatSeq < 1) rec.chatSeq += 1;
    const requestId = `lesson-chat-${key}-${rec.chatSeq}`;
    message.state = "pending";
    delete message.error;
    chatting.add(key);
    streams.delete(key);
    const history = rec.chat
      .filter((m) => m !== message && m.state === "sent")
      .slice(-12)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 1500) }));
    // Still the same conversation: regenerating a lesson replaces its chat.
    const current = () => rec.lesson === lesson && rec.chat.includes(message);
    queueSave(rec);
    changed();
    try {
      if (!available()) throw Error("Claude is not connected.");
      const reply = await host.request(
        "lesson-chat",
        {
          requestId,
          lessonId: key,
          instruction: LESSON_CHAT_POLICY,
          responseFormat: "{text, section?}",
          lesson: {
            title: lesson.title,
            text: lessonPlainText(lesson, LESSON_LIMITS.bytes),
          },
          gap: {
            description: rec.gapDescription ?? lesson.title,
          },
          sectionIds,
          ...(focus && sectionIds.includes(focus) ? { focus } : {}),
          history,
          message: message.text.slice(0, MESSAGE_CHARS),
        },
        {
          onText: (text) => {
            if (!current()) return;
            streams.set(key, text);
            changed();
          },
        },
      );
      if (!isRecord(reply) || typeof reply.text !== "string")
        throw Error("The reply could not be read.");
      if ("requestId" in reply && reply.requestId !== requestId)
        throw Error("The reply did not match the question.");
      const text = reply.text.trim().slice(0, LESSON_LIMITS.chatText);
      if (!text) throw Error("The reply was empty.");
      if (current()) {
        message.state = "sent";
        rec.chat.push({
          id: `m-${shortId()}`,
          role: "tutor",
          text,
          at: now(),
          state: "sent",
          ...(typeof reply.section === "string" &&
          sectionIds.includes(reply.section)
            ? { section: reply.section }
            : {}),
        });
        focusOf.delete(message.id);
      }
    } catch (error) {
      if (current()) {
        message.state = "failed";
        message.error = isInterruption(error)
          ? CUT_OFF_REPLY
          : plain(error, "The reply did not arrive");
      }
    } finally {
      // A replaced lesson already released the key; a newer request owns it.
      if (current()) {
        chatting.delete(key);
        streams.delete(key);
      }
      trimChat(rec);
      queueSave(rec);
      changed();
    }
    await writes;
    return true;
  }

  /** Lessons and chat messages that were only cut off, with the gap a lesson
   * is written for. A lesson whose gap is gone waits for the learner. */
  function findResumable(g: StudyRecord) {
    const found: { rec: LessonEntry; gap?: KnowledgeGapRecord }[] = [];
    for (const rec of records.values()) {
      if (generating.has(rec.key) || chatting.has(rec.key)) continue;
      if (rec.state === "interrupted") {
        const gap = g.study.knowledgeGaps?.find((k) => k.id === rec.key);
        if (gap) found.push({ rec, gap });
        continue;
      }
      const last = rec.chat[rec.chat.length - 1];
      if (
        rec.state === "ready" &&
        last?.role === "learner" &&
        last.state === "failed" &&
        cutOff(last)
      )
        found.push({ rec });
    }
    return found;
  }

  function available() {
    const have = host.capabilities();
    return have.includes("lesson") && have.includes("lesson-chat");
  }

  async function generate(
    g: StudyRecord,
    r: Roadmap,
    gap: KnowledgeGapRecord,
    options?: { fresh?: boolean },
  ): Promise<void> {
    const key = gap.id;
    let rec = records.get(key);
    if (generating.has(key) || rec?.state === "pending") return;
    if (rec?.lesson && !options?.fresh) return;
    generating.add(key);
    // Only a lost connection or an unfinished request keeps its identity;
    // see `answered` below for the other case.
    const retrying =
      !!rec &&
      (rec.state === "failed" || rec.state === "interrupted") &&
      !!rec.requestId;
    const attempt = (rec?.attempt ?? 0) + 1;
    const requestId = retrying
      ? rec!.requestId
      : `lesson-${key}-${attempt}-${shortId()}`;
    const description = gap.facet.description.slice(0, 600);
    if (!rec) {
      rec = {
        key,
        state: "pending",
        requestId,
        attempt,
        createdAt: now(),
        responses: {},
        chat: [],
        chatSeq: 0,
        gapDescription: description,
      };
      records.set(key, rec);
    } else {
      rec.state = "pending";
      rec.requestId = requestId;
      rec.attempt = attempt;
      rec.gapDescription = description;
      delete rec.error;
    }
    const target = rec;
    const previousTitle = target.lesson?.title;
    queueSave(target);
    changed();
    // Set once the bridge has answered: a failure after that is the app
    // refusing the reply, not a transport failure.
    let answered = false;
    try {
      if (!available())
        throw Error("Claude is not connected, so no lesson can be written.");
      const reply = await host.request(
        "lesson",
        lessonPayload(g, r, gap, requestId, previousTitle),
      );
      answered = true;
      if (!isRecord(reply)) throw Error("The reply could not be read.");
      if (reply.requestId !== requestId || reply.gapId !== key)
        throw Error("The reply was for a different request.");
      const { lesson, dropped } = normalizeLesson(reply.lesson);
      // The first valid lesson, or the replacement, lands in one step; a
      // replacement also clears what belonged to the old one.
      if (target.lesson) {
        target.responses = {};
        target.chat = [];
        delete target.readAt;
        // An older chat request may still be in flight: let go of the key
        // so the new conversation can send.
        chatting.delete(key);
        streams.delete(key);
      }
      target.lesson = lesson;
      if (dropped.length) target.dropped = dropped;
      else delete target.dropped;
      target.state = "ready";
      delete target.error;
    } catch (error) {
      // Only a cut line keeps the request to be sent again by itself.
      const cut = !answered && isInterruption(error);
      target.state = cut ? "interrupted" : "failed";
      target.error = cut
        ? LESSON_CUT_OFF
        : plain(
            error,
            answered
              ? "The lesson that came back could not be used"
              : "The lesson could not be written",
          );
      // The gateway keeps an accepted answer by request id, so a retry under
      // the same identity would be handed the reply the app just refused.
      if (answered) target.requestId = `lesson-${key}-${attempt}-${shortId()}`;
    } finally {
      generating.delete(key);
    }
    queueSave(target);
    changed();
    await writes;
  }

  /** Sends the last message again when it failed: under its own request id
   * when it was only cut off, under a new one when its reply was refused. */
  async function retryChat(key: string): Promise<boolean> {
    const rec = records.get(key);
    if (!rec?.lesson || rec.state !== "ready" || chatBusy(rec)) return false;
    const last = rec.chat[rec.chat.length - 1];
    if (last?.role !== "learner" || last.state !== "failed") return false;
    return runChat(rec, last, cutOff(last));
  }

  return {
    /** Reads saved lessons. A request that was in flight when the page closed
     * is marked interrupted; its answer is not coming. */
    async load(): Promise<void> {
      try {
        const saved = await host.store.all();
        loadProblem = "";
        for (const rec of saved) {
          // A record already started this session is newer than the saved one.
          if (records.has(rec.key)) continue;
          let touched = false;
          if (rec.state === "pending") {
            rec.state = "interrupted";
            rec.error = LESSON_CUT_OFF;
            touched = true;
          }
          for (const m of rec.chat)
            if (m.state === "pending") {
              m.state = "failed";
              m.error = PAGE_CLOSED_REPLY;
              touched = true;
            }
          records.set(rec.key, rec);
          if (touched) queueSave(rec);
        }
      } catch (error) {
        loadProblem = plain(error, "Saved lessons could not be read");
      }
      changed();
      await writes;
    },
    /** Why the lesson database could not be read, or "". Lessons still work
     * for this session, without saving. */
    loadError: () => loadProblem,
    /** Why the last save of this record failed, or "". */
    saveError: (key: string) => saveNotes.get(key) ?? "",
    record: (key: string): LessonEntry | undefined => records.get(key),
    available,
    generate,
    /** "Done reading". Display only: it records nothing about knowing. */
    markRead(key: string): void {
      const rec = records.get(key);
      if (!rec?.lesson || rec.readAt) return;
      rec.readAt = now();
      queueSave(rec);
      changed();
    },
    /** The learner's own answer to a predict or recall block. Saved after a
     * short pause; `flush()` saves now. */
    setResponse(key: string, blockKey: string, value: string): void {
      const rec = records.get(key);
      const at = BLOCK_KEY.exec(blockKey);
      if (!rec?.lesson || !at || typeof value !== "string") return;
      const block = rec.lesson.sections.find((s) => s.id === at[1])?.blocks[
        Number(at[2])
      ];
      if (block?.kind !== "predict" && block?.kind !== "recall") return;
      if (value === "") delete rec.responses[blockKey];
      else if (
        blockKey in rec.responses ||
        Object.keys(rec.responses).length < LESSON_STORE_LIMITS.responses
      )
        rec.responses[blockKey] = value.slice(
          0,
          LESSON_STORE_LIMITS.responseText,
        );
      else return;
      const waiting = timers.get(key);
      if (waiting !== undefined) clearTimeout(waiting);
      const timer = setTimeout(() => {
        timers.delete(key);
        queueSave(rec);
      }, SAVE_DELAY_MS);
      // A pending save must not keep a process alive.
      (timer as { unref?: () => void }).unref?.();
      timers.set(key, timer);
    },
    /** Resolves true when the message was accepted and a request started, so
     * the caller can keep the learner's text otherwise. Never throws. */
    async send(
      key: string,
      text: string,
      focusSection?: string,
    ): Promise<boolean> {
      const rec = records.get(key);
      const body = typeof text === "string" ? text.trim() : "";
      if (!body || !rec || rec.state !== "ready" || !rec.lesson) return false;
      if (chatBusy(rec)) return false;
      const message: LessonMessage = {
        id: `m-${shortId()}`,
        role: "learner",
        text: body.slice(0, MESSAGE_CHARS),
        at: now(),
        state: "pending",
      };
      if (focusSection) focusOf.set(message.id, focusSection);
      rec.chat.push(message);
      trimChat(rec);
      return runChat(rec, message);
    },
    retryChat,
    /** Sends again, by itself, each lesson and chat message whose request a
     * reload or a lost relay cut off. A refused one waits for the learner. */
    resume(g: StudyRecord, r: Roadmap): void {
      if (!available()) return;
      for (const { rec, gap } of findResumable(g))
        if (gap) void generate(g, r, gap, { fresh: !!rec.lesson });
        else void retryChat(rec.key);
    },
    /** Whether `resume` has anything to send, and can send it now. */
    resumable: (g: StudyRecord) => available() && findResumable(g).length > 0,
    /** The tutor's reply so far while it is still being written. Display only. */
    streaming: (key: string): string | undefined => streams.get(key),
    /** Saves any answer still waiting for its pause, and waits for every write. */
    async flush(): Promise<void> {
      for (const key of [...timers.keys()]) {
        const rec = records.get(key);
        if (rec) queueSave(rec);
      }
      await writes;
    },
  };
}

export type Lessons = ReturnType<typeof createLessons>;
