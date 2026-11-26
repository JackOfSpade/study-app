import { expect, test, type Page } from "@playwright/test";
import {
  flushStudySave,
  mockClaudeStudy,
  openStudyQuestion,
} from "./study-harness";

const help = { nudges: [], hints: [], gives: [], offers: [] };

/** Hold every `assess` bridge call until `release`; answer it with a valid
 * result built from the request's own packet once released. */
async function mockAssess(page: Page) {
  const seen: any[] = [];
  let holding = true;
  let refusing = false;
  let restartingOnce = false;
  const waiting: (() => void)[] = [];
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.operation !== "assess") return route.fallback();
    seen.push(body);
    if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
    if (restartingOnce) {
      restartingOnce = false;
      // What the app server itself answers while the relay restarts.
      return route
        .fulfill({
          status: 502,
          json: {
            error:
              "Study bridge unavailable; it is restarting. Retry in a moment.",
          },
        })
        .catch(() => {});
    }
    if (refusing)
      return route
        .fulfill({
          status: 502,
          json: { error: "Claude refused the review.", code: "claude-failed" },
        })
        .catch(() => {});
    const packet = body.payload.packet,
      c = packet.problem.contract,
      human = packet.history.filter(
        (h: any) =>
          h.author === "human" &&
          ["edit", "reasoning", "test"].includes(h.kind),
      );
    await route
      .fulfill({
        json: {
          historicalMappings: [],
          findings: c.objectiveIds.map((id: string) => ({
            objectiveId: id,
            facet: "scope",
            depth: c.depth,
            outcome: human.length ? "independent" : "unknown",
            evidence: human.length ? [human[0].seq] : [],
            execution: "not-run",
            rationale: "Synthetic browser-test finding.",
          })),
          visitOutcome: human.length ? "usable" : "unresolved",
          scopeReviews: [],
          helpAttributions: (packet.assistanceSources ?? []).map((m: any) => ({
            messageId: m.id,
            facets: [],
            rationale: "Fixture prompt supplies no answer.",
          })),
        },
      })
      .catch(() => {});
  });
  return {
    seen,
    /** Answer the next assess call as the app server does while the relay
     * restarts; later calls are answered normally. */
    restartOnce() {
      restartingOnce = true;
    },
    /** Answer later assess calls with a gateway refusal (it names a code). */
    refuse(on = true) {
      refusing = on;
    },
    release() {
      holding = false;
      for (const r of waiting.splice(0)) r();
    },
  };
}

const assessments = (page: Page) =>
  page.evaluate(() =>
    (window as any).__studyApp.record.study.assessments.map((a: any) => ({
      id: a.id,
      status: a.status,
      provenance: a.provenance,
      hasRequest: !!a.request,
      findings: a.findings.length,
    })),
  );

async function solveThreePart(page: Page) {
  const relay = await mockClaudeStudy(page);
  relay.question({
    prompt: "SHARED scenario.",
    parts: ["Ask one.", "Ask two.", "Ask three."],
  });
  const gate = await mockAssess(page);
  const id = await openStudyQuestion(page);
  const say = async (t: string) => {
    await page.locator("#chat-input").fill(t);
    await page.locator("#chat-input").press("Enter");
  };
  for (const n of [1, 2]) {
    relay.reply(() => ({
      help,
      text: `Part ${n} accepted.`,
      complete: false,
      partComplete: true,
    }));
    await say(`answer ${n}`);
    await page.locator("#messages button[data-next-part]").click();
  }
  relay.solve("Solved: all parts covered.");
  await say("answer 3");
  await expect(
    page.locator("#messages .message-complete").last(),
  ).toContainText("Question complete");
  await expect.poll(() => gate.seen.length).toBe(1);
  return { relay, gate, id };
}

/** Reload with the saved record flushed first, as a closing tab would. */
async function reloadPage(page: Page) {
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__studyApp?.record);
}

test("reload during a pending assessment: it is sent again by itself, unchanged, and applies", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { gate, id } = await solveThreePart(page);
  expect((await assessments(page))[0].status).toBe("pending");
  const firstPayload = gate.seen[0].payload;

  await reloadPage(page);
  const selected = await page.evaluate(
    () => (window as any).__studyApp.record.studyWorkspace?.encounter,
  );
  expect(selected).toContain(id);
  // Nobody clicks Retry review: the app resends the saved request itself.
  await expect.poll(() => gate.seen.length).toBe(2);
  expect(gate.seen[1].payload).toEqual(firstPayload);
  expect(gate.seen[1].payload).toEqual(gate.seen[0].payload);
  await expect(page.locator("#study-next")).toBeDisabled();

  // The relay answers after the reload.
  gate.release();
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  await expect(page.locator("#study-review-retry")).toBeHidden();
  await expect(page.locator("#study-next")).toBeEnabled();
  expect(gate.seen.length).toBe(2);
  expect(errors).toEqual([]);
});

test("a second reload while the resent review is in flight resends it again", async ({
  page,
}) => {
  const { gate } = await solveThreePart(page);
  const firstPayload = gate.seen[0].payload;
  await reloadPage(page);
  await expect.poll(() => gate.seen.length).toBe(2);
  await reloadPage(page);
  await expect.poll(() => gate.seen.length).toBe(3);
  expect(gate.seen[2].payload).toEqual(firstPayload);
  gate.release();
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  await expect(page.locator("#study-next")).toBeEnabled();
});

test("relay down at load: the review waits with Retry review, then resumes by itself when the relay answers", async ({
  page,
}) => {
  const { relay, gate } = await solveThreePart(page);
  const firstPayload = gate.seen[0].payload;
  relay.setAvailable(false);
  await reloadPage(page);
  await expect(page.locator("#study-review-retry")).toBeVisible();
  await expect(page.locator("#study-next")).toBeDisabled();
  expect((await assessments(page))[0].status).toBe("review-required");
  // Nothing was sent while the relay was down.
  await page.waitForTimeout(800);
  expect(gate.seen.length).toBe(1);

  relay.setAvailable(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => gate.seen.length).toBe(2);
  expect(gate.seen[1].payload).toEqual(firstPayload);
  gate.release();
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  await expect(page.locator("#study-review-retry")).toBeHidden();
  await expect(page.locator("#study-next")).toBeEnabled();
});

test("a refused review is not resent on reload; Retry review rechecks the relay first", async ({
  page,
}) => {
  const { gate } = await solveThreePart(page);
  gate.refuse();
  gate.release();
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("review-required");
  await expect(page.locator("#study-review-retry")).toBeVisible();

  await reloadPage(page);
  await expect(page.locator("#study-review-retry")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(gate.seen.length).toBe(1);
  expect((await assessments(page))[0].status).toBe("review-required");
  await expect(page.locator("#study-next")).toBeDisabled();

  // Record the order of status checks and assess calls from now on.
  const order: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/status") order.push("status");
    else if (u.pathname === "/api/bridge" && r.method() === "POST")
      if (r.postDataJSON()?.operation === "assess") order.push("assess");
  });
  gate.refuse(false);
  await page.locator("#study-review-retry").click();
  await expect.poll(() => gate.seen.length).toBe(2);
  expect(order.indexOf("status")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("status")).toBeLessThan(order.indexOf("assess"));
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  await expect(page.locator("#study-next")).toBeEnabled();
});

test("a tutor reply cut off by a reload is sent again by itself and shown once", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await openStudyQuestion(page);
  relay.reply(() => ({
    help,
    text: "Resumed tutor answer.",
    complete: false,
  }));
  relay.hold();
  await page.locator("#chat-input").fill("my unique learner message");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  const first = relay.tutorCalls()[0].payload;

  await reloadPage(page);
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  expect(relay.tutorCalls()[1].payload).toEqual(first);
  relay.release();
  await expect(
    page.locator("#messages .message", { hasText: "Resumed tutor answer." }),
  ).toHaveCount(1);
  await expect(
    page.locator("#messages .message", {
      hasText: "my unique learner message",
    }),
  ).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(relay.tutorCalls().length).toBe(2);
});

test("the next question cannot start while the reloaded assessment is unresolved", async ({
  page,
}) => {
  const { gate } = await solveThreePart(page);
  await reloadPage(page);
  await expect(page.locator("#study-next")).toBeDisabled();
  // Bypass the disabled button the way the scheduler would be reached.
  const outcome = await page.evaluate(async () => {
    const root = "/src/";
    const { nextWorkspaceQuestion } = await import(
      /* @vite-ignore */ root + "study-workspace.ts"
    );
    const d = (window as any).__studyApp;
    const before = Object.keys(d.record.encounters).length;
    try {
      nextWorkspaceQuestion(d.record, d.roadmap);
      return {
        threw: false,
        before,
        after: Object.keys(d.record.encounters).length,
      };
    } catch (e) {
      return {
        threw: String(e),
        before,
        after: Object.keys(d.record.encounters).length,
      };
    }
  });
  console.log(
    "nextWorkspaceQuestion while review-required:",
    JSON.stringify(outcome),
  );
  expect(outcome.after).toBe(outcome.before);
  gate.release();
});

test("after the resent review applies, the ledger credits the question once and the next question is a different one", async ({
  page,
}) => {
  const { gate, id } = await solveThreePart(page);
  const contractOf = () =>
    page.evaluate(
      () => (window as any).__studyApp.record.study.pending ?? null,
    );
  const first = await page.evaluate((k) => {
    const g = (window as any).__studyApp.record;
    return g.encounters[k].problem.contract.objectiveIds as string[];
  }, id);
  await reloadPage(page);
  const ledger = () =>
    page.evaluate(() => {
      const l = (window as any).__studyApp.record.study.learner;
      return {
        attempts: l.attempts.map((a: any) => ({
          status: a.status,
          encounter: a.encounter,
        })),
        version: l.version,
      };
    });
  console.log("ledger before retry:", JSON.stringify(await ledger()));
  await expect.poll(() => gate.seen.length).toBe(2);
  gate.release();
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  console.log("ledger after retry:", JSON.stringify(await ledger()));
  console.log("pending:", JSON.stringify(await contractOf()));
  await expect(page.locator("#study-next")).toBeEnabled();
  await page.locator("#study-next").click();
  await expect(page.locator("#problem-title")).not.toHaveText("Connecting…");
  const second = await page.evaluate(() => {
    const g = (window as any).__studyApp.record;
    const k = g.studyWorkspace.encounter;
    const e = [...Object.values(g.encounters), ...g.study.archives].find(
      (x: any) => `${x.runId}/${x.id}` === k || x.id === k,
    ) as any;
    return {
      id: e?.id,
      objectives: e?.problem?.contract.objectiveIds,
      depth: e?.problem?.contract.depth,
      kind: e?.problem?.contract.kind,
    };
  });
  console.log("second question:", JSON.stringify(second), "first:", first);
  console.log("ledger after next:", JSON.stringify(await ledger()));
  expect(second.id).not.toBe(id.split("/").at(-1));
});

test("a review cut off while the page stays open is sent again by itself, with no reload", async ({
  page,
}) => {
  const { gate } = await solveThreePart(page);
  gate.restartOnce();
  gate.release();
  // The relay status never changes, so no reconnect will come to resend it.
  await expect.poll(() => gate.seen.length, { timeout: 10_000 }).toBe(2);
  expect(gate.seen[1].payload).toEqual(gate.seen[0].payload);
  await expect
    .poll(async () => (await assessments(page))[0].status)
    .toBe("applied");
  await expect(page.locator("#study-next")).toBeEnabled();
});
