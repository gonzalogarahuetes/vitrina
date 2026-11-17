/*
 * The JPEG quality page's pure parts: no DOM, so test/jpeg-quality-bench.test.ts
 * runs them under Node. main.ts does the drawing and the encoding.
 */

export const ASSET_QUALITIES = [0.7, 0.75, 0.8, 0.85, 0.9] as const;
export const THUMB_QUALITIES = [0.7, 0.75, 0.8] as const;

export type Kind = "asset" | "thumb";

/** One encode: what the CSV carries, and nothing else (no pixels, no filename). */
export type Row = {
  /** 1-based, in the order the photos were picked. */
  readonly photo: number;
  readonly browser: string;
  readonly width: number;
  readonly height: number;
  readonly kind: Kind;
  readonly quality: number;
  readonly bytes: number;
  readonly encodeMs: number;
};

/**
 * A short label from the user agent: browser, major version where it says
 * something, OS. Never the UA itself. Safari on a Mac is "Safari / macOS":
 * Apple's encoder is measured there in place of an iPhone's.
 */
export function browserLabel(ua: string, maxTouchPoints = 0): string {
  const os = (() => {
    const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
    if (android) return `Android ${android[1]}`;
    const ios = /(?:iPhone|CPU) OS (\d+)_(\d+)/.exec(ua);
    if (ios) return `iOS ${ios[1]}.${ios[2]}`;
    // An iPad asks for the desktop site and says Macintosh; only its touch points tell.
    if (/Macintosh/.test(ua)) return maxTouchPoints > 1 ? "iPadOS" : "macOS";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    return "other OS";
  })();
  const major = (re: RegExp): string => re.exec(ua)?.[1] ?? "?";
  if (/SamsungBrowser\//.test(ua)) return `Samsung Internet ${major(/SamsungBrowser\/(\d+)/)} / ${os}`;
  if (/Edg(?:A|iOS)?\//.test(ua)) return `Edge ${major(/Edg(?:A|iOS)?\/(\d+)/)} / ${os}`;
  if (/Firefox\/|FxiOS\//.test(ua)) return `Firefox ${major(/(?:Firefox|FxiOS)\/(\d+)/)} / ${os}`;
  if (/CriOS\//.test(ua)) return `Chrome ${major(/CriOS\/(\d+)/)} (WebKit) / ${os}`;
  if (/Chrome\//.test(ua)) return `Chrome ${major(/Chrome\/(\d+)/)} / ${os}`;
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return os === "macOS" ? "Safari / macOS" : `Safari ${major(/Version\/(\d+)/)} / ${os}`;
  return `other / ${os}`;
}

/**
 * What a browser said when it refused a photo: the error's name and message,
 * for the failure report. A message that names the file is cut to the name
 * alone, so a filename never reaches the text that is copied out.
 */
export function describeError(e: unknown, fileName: string): string {
  if (!(e instanceof Error)) return typeof e;
  const message = e.message.trim();
  if (message === "" || (fileName !== "" && message.includes(fileName))) return e.name;
  return `${e.name}: ${message}`;
}

/** The copied text: the CSV, then one comment line per failed photo, numbers and browser answers only. */
export function report(rows: readonly Row[], failed: ReadonlyMap<number, string>): string {
  const lines = [...failed].sort(([a], [b]) => a - b).map(([photo, why]) => `# photo ${photo} failed: ${why.replace(/\n/g, " ")}`);
  return toCsv(rows) + (lines.length ? `# ${lines.length} failed\n${lines.join("\n")}\n` : "");
}

export const CSV_HEADER = "photo,browser,width,height,kind,quality,bytes,encode_ms";

export function toCsv(rows: readonly Row[]): string {
  const field = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = rows.map((r) =>
    [r.photo, field(r.browser), r.width, r.height, r.kind, r.quality.toFixed(2), r.bytes, r.encodeMs.toFixed(1)].join(","),
  );
  return [CSV_HEADER, ...lines].join("\n") + "\n";
}

/** Fisher–Yates with an injected source, so the blind order is testable. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Viewer.svelte's stage in a viewport: full width; the height less the top bar (76) and the control row (12 + 60 + 16), never under 45%. No caption. */
export function viewerStage(viewport: { w: number; h: number }): { w: number; h: number } {
  return { w: viewport.w, h: Math.max(viewport.h - 164, viewport.h * 0.45) };
}

/** Grid.svelte's cell: 960 px at most, 16 px each side, 8 px gaps, two columns under 640 px and three from it. */
export function gridCell(viewportW: number): number {
  const cols = viewportW >= 640 ? 3 : 2;
  const inner = Math.min(viewportW, 960) - 32;
  return Math.floor((inner - 8 * (cols - 1)) / cols);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export type Summary = { readonly quality: number; readonly n: number; readonly medianBytes: number; readonly maxBytes: number; readonly album30: number; readonly medianMs: number; readonly maxMs: number };

/** Per quality of one kind: median and largest size, a 30-photo album at the median, encode time. */
export function summarise(rows: readonly Row[], kind: Kind, qualities: readonly number[]): Summary[] {
  return qualities.map((quality) => {
    const of = rows.filter((r) => r.kind === kind && r.quality === quality);
    const bytes = of.map((r) => r.bytes);
    const ms = of.map((r) => r.encodeMs);
    const med = median(bytes);
    return { quality, n: of.length, medianBytes: med, maxBytes: of.length ? Math.max(...bytes) : NaN, album30: med * 30, medianMs: median(ms), maxMs: of.length ? Math.max(...ms) : NaN };
  });
}
