export function normaliseAddress(asTyped: string): string {
  return asTyped
    .normalize("NFC")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .toLowerCase()
    .replace(/\u03c2/g, "\u03c3");
}
