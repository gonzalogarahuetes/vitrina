/*
 * UUIDs between their two spellings: the 36-character text the API's paths and
 * bodies use, and the 16 raw bytes the binding takes as `assetId`, `albumId` and
 * `recipientId`. Not cryptography: the binding owns every derivation and AAD;
 * this only hands it the identifier it asks for.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class MalformedId extends Error {
  override readonly name = "MalformedId";
}

/** Lowercase only: the server emits lowercase, and one spelling compares by `===`. */
export function uuidToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!UUID.test(text)) throw new MalformedId("not a lowercase uuid");
  const hex = text.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new MalformedId("a uuid is 16 bytes");
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
