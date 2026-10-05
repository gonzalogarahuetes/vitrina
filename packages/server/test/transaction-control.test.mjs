/*
 * The runner's transaction-control check (scripts/transaction-control.mjs).
 * Hermetic: the check is a pure function over the file's text, so it is
 * tested here rather than through a database in infra/.
 *
 * Both directions matter. A check that stopped refusing a bare BEGIN would let
 * a file take the transaction away from the runner, and one that refused every
 * DO block or every COMMENT ON body with an unlucky line would push the next
 * migration into formatting its way past the check.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { blankNonStatements, findTransactionControl } from "../scripts/transaction-control.mjs";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

describe("statement-level transaction control is refused, with its line", () => {
  for (const [sql, line] of [
    ["BEGIN;\nCREATE TABLE t (a int);", 1],
    ["CREATE TABLE t (a int);\n  commit;", 2],
    ["SELECT 1;\nROLLBACK;", 2],
    ["SELECT 1;\n\nEND;", 3],
    ["start transaction;\nSELECT 1;", 1],
    ["Begin Transaction;", 1],
  ]) {
    it(JSON.stringify(sql), () => {
      assert.equal(findTransactionControl(sql), line);
    });
  }
});

describe("text that is not a statement is not scanned", () => {
  it("a PL/pgSQL DO block — 003's guard", () => {
    const sql = [
      "DO $$",
      "BEGIN",
      "    IF EXISTS (SELECT 1 FROM albums) THEN",
      "        RAISE EXCEPTION 'no';",
      "    END IF;",
      "END",
      "$$;",
    ].join("\n");
    assert.equal(findTransactionControl(sql), null);
  });

  it("a COMMENT ON body with a line starting with End or Commit", () => {
    const sql = "COMMENT ON COLUMN t.a IS\n$$Something long\nEnd of the first point.\nCommit history is not this.$$;";
    assert.equal(findTransactionControl(sql), null);
  });

  it("a block comment with a line starting with END", () => {
    assert.equal(findTransactionControl("/*\nEND of header\n*/\nSELECT 1;"), null);
  });

  it("a tagged dollar quote, closed only by its own tag", () => {
    // The inner $$ must not close $body$, or "END" would be exposed.
    const sql = "DO $body$\nBEGIN\n  PERFORM '$$';\nEND\n$body$;";
    assert.equal(findTransactionControl(sql), null);
  });
});

describe("blanking keeps line numbers true", () => {
  it("a statement after a multi-line DO block is reported at its real line", () => {
    const sql = "DO $$\nBEGIN\n  NULL;\nEND\n$$;\nCOMMIT;";
    assert.equal(findTransactionControl(sql), 6);
  });

  it("every newline survives, and nothing outside the bodies changes", () => {
    const sql = "SELECT 1; /* a\nb */ SELECT $$x\ny$$;";
    const blanked = blankNonStatements(sql);
    assert.equal(blanked.split("\n").length, sql.split("\n").length);
    assert.equal(blanked.length, sql.length);
    assert.ok(blanked.startsWith("SELECT 1; "));
    assert.doesNotMatch(blanked, /[aby]/);
  });

  it("a positional parameter is not taken for a dollar quote", () => {
    // $1 cannot open a quote, so the COMMIT after it is still seen.
    assert.equal(findTransactionControl("SELECT $1;\nCOMMIT;"), 2);
  });
});

it("every migration from 003 on passes the check", async () => {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => Number(n.slice(0, 3)) >= 3);
  assert.ok(names.length > 0, "003 exists");
  for (const name of names) {
    const text = await readFile(new URL(name, MIGRATIONS_DIR), "utf8");
    assert.equal(findTransactionControl(text), null, name);
  }
});
