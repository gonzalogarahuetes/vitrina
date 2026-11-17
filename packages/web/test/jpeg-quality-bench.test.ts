/*
 * The JPEG quality page (scripts/jpeg-quality/): its pure parts, and the two
 * things that keep it out of the app and off the network. check-build.mjs
 * refuses a build/ that carries the page's marker; this keeps that check from
 * passing vacuously, by holding the marker in the page and in the check to
 * the same string. The CSP is what refuses every request from the page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSV_HEADER, browserLabel, describeError, gridCell, median, report, shuffled, summarise, toCsv, viewerStage, type Row } from "../scripts/jpeg-quality/bench";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const MARKER = /"(vitrina:jpeg-quality-bench)"/;

describe("the JPEG quality page stays out of the production build", () => {
  it("check-build.mjs looks for the very string the page writes", () => {
    const page = MARKER.exec(read("../scripts/jpeg-quality/main.ts"))?.[1];
    const check = MARKER.exec(read("../scripts/check-build.mjs"))?.[1];
    expect(page).toBe("vitrina:jpeg-quality-bench");
    expect(check).toBe(page);
    // Written into the page, so a bundle importing main.ts cannot tree-shake it away.
    expect(read("../scripts/jpeg-quality/main.ts")).toMatch(/dataset\["page"\] = BENCH_MARKER/);
  });
});

describe("the JPEG quality page sends nothing", () => {
  const html = read("../scripts/jpeg-quality/index.html");
  const metas = [...html.matchAll(/<meta http-equiv="content-security-policy" content="([^"]*)"/gi)];
  const directives = new Map((metas[0]?.[1] ?? "").split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([n, ...v]) => [n, v.join(" ")]));

  it("has one CSP, and it refuses every request, image load and form post", () => {
    expect(metas).toHaveLength(1);
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("connect-src")).toBe("'none'");
    expect(directives.get("img-src")).toBe("'none'");
    expect(directives.get("form-action")).toBe("'none'");
    expect(directives.get("script-src")).toBe("'self'");
  });

  it("exports numbers only: no filename, no pixels", () => {
    expect(CSV_HEADER).toBe("photo,browser,width,height,kind,quality,bytes,encode_ms");
  });
});

describe("browserLabel", () => {
  const cases: [string, string, number, string][] = [
    ["Chrome on Android", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36", 5, "Chrome 148 / Android 10"],
    ["Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15", 0, "Safari / macOS"],
    ["Safari on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1", 5, "Safari 27 / iOS 18.7"],
    ["an iPad asking for the desktop site", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15", 5, "Safari 27 / iPadOS"],
    ["Chrome on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36", 0, "Chrome 148 / macOS"],
    ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-A156B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36", 5, "Samsung Internet 28 / Android 14"],
    ["Chrome on iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/148.0.0.0 Mobile/15E148 Safari/604.1", 5, "Chrome 148 (WebKit) / iOS 18.7"],
  ];
  for (const [what, ua, touch, label] of cases) it(`labels ${what}`, () => expect(browserLabel(ua, touch)).toBe(label));
  it("never carries the device model", () => expect(browserLabel(cases[5]?.[1] ?? "", 5)).not.toMatch(/SM-/));
});

const row = (photo: number, kind: Row["kind"], quality: number, bytes: number, encodeMs = 10): Row => ({ photo, browser: "Safari / macOS", width: 1600, height: 1200, kind, quality, bytes, encodeMs });

describe("toCsv", () => {
  it("writes one line per encode, quality to two places, time to one", () => {
    expect(toCsv([row(1, "asset", 0.7, 312345, 182.04), row(1, "thumb", 0.8, 41000, 9)])).toBe(
      `${CSV_HEADER}\n1,Safari / macOS,1600,1200,asset,0.70,312345,182.0\n1,Safari / macOS,1600,1200,thumb,0.80,41000,9.0\n`,
    );
  });
  it("quotes a browser label with a comma", () => {
    expect(toCsv([{ ...row(1, "asset", 0.7, 1), browser: 'a,"b"' }])).toContain('"a,""b"""');
  });
});

describe("shuffled", () => {
  it("is a permutation and leaves its input alone", () => {
    const xs = [0.7, 0.75, 0.8, 0.85, 0.9];
    const out = shuffled(xs, () => 0);
    expect([...out].sort()).toEqual(xs);
    expect(out).not.toEqual(xs);
    expect(xs).toEqual([0.7, 0.75, 0.8, 0.85, 0.9]);
  });
});

describe("the viewer's stage and the grid's cell, as the app lays them out", () => {
  it("takes the viewer's top bar and control row off the height, never below 45%", () => {
    expect(viewerStage({ w: 390, h: 844 })).toEqual({ w: 390, h: 680 });
    expect(viewerStage({ w: 390, h: 200 })).toEqual({ w: 390, h: 90 });
  });
  it("is two columns on a phone and three from 640 px", () => {
    expect(gridCell(390)).toBe(175); // (390 - 32 - 8) / 2
    expect(gridCell(360)).toBe(160);
    expect(gridCell(700)).toBe(217); // (700 - 32 - 16) / 3, floored
    expect(gridCell(1400)).toBe(304); // 960 at most
  });
});

describe("summarise", () => {
  it("gives the median, the largest and a 30-photo album per quality", () => {
    const rows = [row(1, "asset", 0.85, 300), row(2, "asset", 0.85, 100), row(3, "asset", 0.85, 200, 50), row(1, "thumb", 0.85, 999)];
    const [s] = summarise(rows, "asset", [0.85]);
    expect(s).toEqual({ quality: 0.85, n: 3, medianBytes: 200, maxBytes: 300, album30: 6000, medianMs: 10, maxMs: 50 });
  });
  it("takes the middle two's mean for an even count", () => expect(median([4, 1, 3, 2])).toBe(2.5));
});

describe("the failure report", () => {
  it("gives the browser's error name and message", () => {
    expect(describeError(new DOMException("The source image could not be decoded.", "InvalidStateError"), "IMG_1.jpg")).toBe("InvalidStateError: The source image could not be decoded.");
  });
  it("drops a message that names the file", () => {
    expect(describeError(new Error("cannot read IMG_20260612_bathtime.jpg"), "IMG_20260612_bathtime.jpg")).toBe("Error");
  });
  it("puts one comment line per failed photo after the CSV, in photo order", () => {
    const text = report([row(1, "asset", 0.7, 100)], new Map([[3, "not-decoded: x"], [2, "not-decoded: y\nz"]]));
    expect(text).toBe(`${CSV_HEADER}\n1,Safari / macOS,1600,1200,asset,0.70,100,10.0\n# 2 failed\n# photo 2 failed: not-decoded: y z\n# photo 3 failed: not-decoded: x\n`);
  });
  it("adds nothing when nothing failed", () => expect(report([], new Map())).toBe(`${CSV_HEADER}\n`));
});
