# Local diagnostics and bug reports

Diagnostics stay in this browser under `recent-study-diagnostics-v1` (in the durable store `study-durable-state`; earlier builds used `dead-air-durable-state`, which is carried over), separate from the learning save. They are for agents and bug reports, not for download from the interface: read them with `window.__studyApp.logs()` on the page. No upload or model request is involved. Earlier builds wrote `recent-game-diagnostics-v1`; when the new key is absent the app reads that one, and every write goes to the new key. The old entry is never deleted.

## What is recorded

Each entry is `{at, type, data}`, where `at` is the wall-clock time as an ISO string. The workspace records:

- `terminal-message` (message length only) and `terminal-message-blocked` (empty message, or a tutor reply still pending);
- `help-offer-answered` when the learner answers the tutor's hint warning with a button: `answer` is `accept` (the hint is unlocked and the part will be recorded as hinted) or `move-on`, with the number of facets offered. A typed reply to the warning is a `terminal-message` like any other;
- `tutor-reply` (question id, request id and whether the reply finished the question) and `tutor-reply-failed` (the same ids and a short error);
- `question-completed` and `assessment-settled` (ids, the assessment's status, visit outcome and number of findings);
- `question-regenerated` (question id and the title of the question that was replaced). The first writing of a question logs nothing here; its `generate` call is in the usage log;
- `gap-practice-started` (the practice question's id);
- `lesson-requested` (gap id and whether a fresh rewrite was asked for), `lesson-opened` and `lesson-closed` (gap id), `lesson-message` (gap id and message length only) and `lesson-draw-failed` (gap id and an error message cut to 200 characters);
- `save-fallback-copy-failed` and `save-fallback-copy-restored` (the save's length; logged when the localStorage copy stops or resumes being written, not on every save), and the `save-legacy-*` events for the earlier build's copies (which store, and a short error);
- `browser-error` and `unhandled-rejection` (file, line, column and a message cut to 300 characters);
- `bug-report` (which action was used, its outcome and whether a description was given).

Diagnostics never hold drafts, conversations, question text or curriculum.

## Hard limits

- Entries are grouped by the record id (`StudyRecord.id`) that was open when they were written. Only the newest three records are kept; older ones are removed.
- At most 400 entries per record, oldest dropped first.
- Each serialized record is at most **256,000 UTF-8 bytes**; the oldest entries are dropped to fit.
- Each entry is serialized once when recorded, so retention and writes never re-serialize a whole record. Writes are ordered, and a slower older write cannot replace a newer one. If a write fails, the status line says diagnostics could not be saved.
- A damaged stored document is skipped without discarding valid records. Entries restored from storage are checked for shape and length.

Verify with `node --import tsx --test tests/run-logs.test.ts`. Tests use memory-only storage and synthetic records; they do not read real saves or learning history.

## Bug reports

**Report a bug** in the workspace toolbar opens a dialog with an optional description. **Copy to clipboard** posts the browser's part to the relay (`POST /api/bug-report`), which writes `.local/bug-reports/bug-report-<time>.md` and returns the path; the clipboard receives that path and the description, never the report body, so an assistant reads the file from disk. **Save to file** downloads the same report instead. If the relay does not answer, the browser's part alone is copied or downloaded.

A report holds:

- the description;
- page, build (the one the page loaded with, and the server's current one when they differ), viewport, view and Claude connection, plus the status lines on screen;
- the current question's state, the open part of a question worked in parts, tutor request states and its scheduling and provenance line (which the workspace no longer displays);
- the question text and conversation, unless the learner unticks that box;
- the browser diagnostics above, newest record first (the oldest detail entries are dropped past 600,000 characters);
- the newest 60 AI calls from `claude-usage.jsonl` (counts, timings and outcomes only), listed by start time. The phase column shows the kind of tutor reply or the number of parts in a generated question, and the turn column the conversation's message count with the open part;
- the last 120 lines of the relay log and the app server log, with repeated blocks collapsed to one copy and a count.

When the relay rejects a Claude reply it writes one line to its log: the task, the attempt, the validation problem and the reply's structure, with every string longer than 24 characters replaced by its length and anything that is not JSON (a reply written as prose, text around the object, an unterminated string) replaced by `<N outside JSON>`. Field names, facet ids and enum values stay readable; conversation text does not. Lines written before 2026-11-23 could carry a prose reply in full.

Reports are owner-only files. The newest 20 are kept and any older than seven days is removed on each write. Service log lines are timestamped. Verify with `node --import tsx --test tests/bug-report.test.ts tests/bug-report-diagnostics.test.ts`.
