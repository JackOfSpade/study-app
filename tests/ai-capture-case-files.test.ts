import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  lastValidAnswer,
  readJsonlRows,
  topicOf,
  writeCaseFiles,
} from "../scripts/ai-capture/case-files";

const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "case-files-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("case files are private and merge into the shared index", () =>
  withDir((dir) => {
    const out = join(dir, "cases");
    writeCaseFiles(out, { "a.json": [1] }, { a: 1 });
    const { index } = writeCaseFiles(out, { "b.json": [1, 2] }, { b: 2 });
    assert.deepEqual(index, { a: 1, b: 2 });
    assert.equal(statSync(out).mode & 0o777, 0o700);
    for (const name of ["a.json", "b.json", "index.json"])
      assert.equal(statSync(join(out, name)).mode & 0o777, 0o600, name);
    assert.equal(
      readFileSync(join(out, "b.json"), "utf8"),
      "[\n  1,\n  2\n]\n",
    );
    assert.equal(
      readFileSync(join(out, "index.json"), "utf8"),
      '{\n  "a": 1,\n  "b": 2\n}\n',
    );
    writeCaseFiles(join(dir, "plain"), { "c.json": [] });
    assert.equal(existsSync(join(dir, "plain", "index.json")), false);
  }));

test("a corrupt index fails before any case file is written", () =>
  withDir((dir) => {
    for (const bad of ["{not json", "[1, 2]", "7"]) {
      writeFileSync(join(dir, "index.json"), bad);
      assert.throws(
        () => writeCaseFiles(dir, { "x.json": [] }, { x: 0 }),
        /index\.json/,
        bad,
      );
      assert.equal(existsSync(join(dir, "x.json")), false, bad);
    }
  }));

test("results rows are read strictly and an arm's answer is exact", () =>
  withDir((dir) => {
    const file = join(dir, "results.jsonl");
    const row = {
      caseId: "c",
      operation: "generate",
      setting: "sonnet:high",
      rep: 0,
      outcome: "valid",
      answers: ["first", "last"],
    };
    writeFileSync(file, `${JSON.stringify(row)}\n\n`);
    const rows = readJsonlRows(file);
    assert.equal(
      lastValidAnswer(rows, {
        caseId: "c",
        operation: "generate",
        setting: "sonnet:high",
        rep: 0,
      }),
      "last",
    );
    assert.equal(
      lastValidAnswer(rows, {
        caseId: "c",
        operation: "generate",
        setting: "sonnet:high",
        rep: 1,
      }),
      undefined,
    );
    writeFileSync(file, `${JSON.stringify(row)}\n{broken\n`);
    assert.throws(() => readJsonlRows(file), /results\.jsonl:2 is not valid/);
    assert.equal(topicOf("PY:T05.2"), "T05");
    assert.equal(topicOf(undefined), "");
  }));
