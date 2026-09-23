/*
 * `Date` → the wire, in one place — api-sketch §7.5.
 * RFC 3339, UTC, trailing Z. NOT "ISO 8601", which admits week dates, ordinal
 * dates and offset-less local times; a format described loosely is one two
 * implementations can disagree about, and two copies of it are two formats.
 */

export const rfc3339 = (at: Date): string =>
  at.toISOString().replace(/\.\d{3}Z$/, "Z");
