// `parseRange` — api-sketch §11.2's table, syntax only. Strict on purpose: the
// client is ours, and the RFC 9110 deviation is recorded there. Every rejected
// row here is a 400 at the route, with no `details` (#15).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { parseRange } = await import("../dist/adapters/driving/http/range.js").catch(() => ({
  parseRange: null,
}));

const ACCEPTED = [
  ["bytes=0-63", { start: 0, end: 63 }],
  ["bytes=262208-524351", { start: 262208, end: 524351 }],
  ["bytes=0-0", { start: 0, end: 0 }], // an end of 0 is an end
  ["bytes=5-5", { start: 5, end: 5 }],
  ["bytes=0-", { start: 0 }],
  ["bytes=262208-", { start: 262208 }],
  ["bytes=007-010", { start: 7, end: 10 }], // leading zeros: same value, allowed
  [`bytes=${Number.MAX_SAFE_INTEGER}-`, { start: Number.MAX_SAFE_INTEGER }],
];

const REJECTED = [
  [undefined, "absent — the asset route requires a range"],
  ["", "empty"],
  ["bytes=-500", "suffix range"],
  ["bytes=0-1,4-5", "multi-range"],
  ["bytes=0-1, bytes=2-3", "two Range headers, as Node joins them"],
  ["items=0-10", "another unit"],
  ["Bytes=0-10", "unit is case-sensitive here, unlike RFC 9110"],
  ["BYTES=0-10", "unit is case-sensitive here, unlike RFC 9110"],
  ["bytes=10-5", "start after end"],
  ["bytes=", "no range"],
  ["bytes=-", "no numbers"],
  ["bytes=a-b", "not digits"],
  ["bytes=1.5-2", "not an integer"],
  ["bytes=+1-2", "signed"],
  ["bytes= 0-1", "whitespace inside"],
  [" bytes=0-1", "leading whitespace"],
  ["bytes=0-1 ", "trailing whitespace"],
  ["bytes=0 -1", "whitespace around the dash"],
  ["bytes=0-1\n", "trailing newline"],
  ["bytes:0-1", "wrong separator"],
  ["bytes=\u0660-", "non-ASCII digit"],
  [`bytes=${Number.MAX_SAFE_INTEGER + 1}-`, "start past a safe integer"],
  ["bytes=0-99999999999999999999", "end past a safe integer"],
];

describe("parseRange — §11.2", () => {
  if (parseRange === null) {
    it("exists", () => assert.fail("range.js is not built — every row below is unasserted"));
    return;
  }

  for (const [header, expected] of ACCEPTED) {
    it(`accepts ${header}`, () => {
      // deepEqual on the whole object: an open range has no `end` key at all,
      // not `end: undefined` (exactOptionalPropertyTypes, and the port says so).
      assert.deepEqual(parseRange(header), expected);
      if (!("end" in expected)) assert.ok(!("end" in parseRange(header)));
    });
  }

  for (const [header, why] of REJECTED) {
    it(`rejects ${JSON.stringify(header)} — ${why}`, () => {
      assert.equal(parseRange(header), null);
    });
  }

  it("never throws, whatever it is given", () => {
    // The route maps null to 400; a throw would be a 500 for a client typo.
    for (const header of [undefined, "", "bytes=0-1".repeat(2000), "\u0000", "bytes=٠-"]) {
      assert.doesNotThrow(() => parseRange(header));
    }
  });
});
