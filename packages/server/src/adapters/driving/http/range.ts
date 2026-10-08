import type { ByteRange } from "../../../application/ports/object-store.js";

const RANGE_REGEX = /^bytes=(\d+)-(\d*)$/;

export function parseRange(header: string | undefined): ByteRange | null {
  const match = RANGE_REGEX.exec(header ?? "");
  if (match === null) return null;

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (match[2] === "") return { start };

  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || start > end) return null;
  return { start, end };
}
