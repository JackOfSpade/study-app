import { openAgentMenu, openApp } from "./helpers/agent-menu";
import { expect, test } from "@playwright/test";
import { waitForStudyApp } from "./study-harness";

test("retrying an assessment durably captures its pending request before a reply arrives", async ({
  page,
}) => {
  let hold = false;
  let bridgeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic assessment fixture",
        detail: "Synthetic transport only",
        capabilities: ["assess"],
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    bridgeCalls++;
    if (hold) await gate;
    await route
      .fulfill({
        status: 503,
        json: { error: "Synthetic interrupted assessment" },
      })
      .catch(() => {});
  });
  try {
    await openApp(page);
    await page.evaluate(async () => {
      const fixtures = "/tests/helpers/practice-questions.ts",
        records = "/tests/helpers/record.ts",
        root = "/src/",
        { assess } = await import(root + "ai.ts"),
        { devProblem } = await import(/* @vite-ignore */ fixtures),
        { question } = await import(/* @vite-ignore */ records),
        { save } = await import(root + "persistence.ts"),
        { record: g, roadmap: r } = (window as any).__studyApp,
        e = (g.encounters["question-0"] = question(g, "question-0"));
      g.study.profile = "live";
      e.problem = devProblem(g, r);
      e.problem.provenance = "claude-cli";
      await assess(g, e, r);
      await save(g);
    });
    await openAgentMenu(page);
    await page.locator("#curriculum-button").click();
    hold = true;
    await page.locator("[data-assessment]").click();
    await expect(page.locator("[data-assessment]")).toBeDisabled();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const root = "/src/",
            { load } = await import(root + "persistence.ts");
          const g = await load();
          return g?.study.assessments[0]?.status;
        }),
      )
      .toBe("pending");
    const request = await page.evaluate(async () => {
      const root = "/src/",
        { load } = await import(root + "persistence.ts");
      return (await load())?.study.assessments[0]?.request;
    });
    expect(request?.provider).toBe("claude-cli");
    expect(JSON.parse(request!.payloadJson).packet.sourceHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    // Reload interrupts the in-flight review while retaining its exact packet;
    // the relay is reachable, so the app sends that same request again by itself.
    const before = bridgeCalls;
    await page.reload();
    await waitForStudyApp(page);
    await expect.poll(() => bridgeCalls).toBe(before + 1);
    const recovered = await page.evaluate(
      () => (window as any).__studyApp.record.study.assessments[0],
    );
    expect(recovered.status).toBe("pending");
    expect(recovered.request).toEqual(request);
  } finally {
    release();
  }
});
