/*
 * The two object keys of a media row — api-sketch §9.7, brief §9.2.
 * Derived, never stored, and written once: PR 5's fetch routes and §4.2's
 * erasure worker must enumerate the same strings these uploads write.
 */

/** Also §9.7's path segments, so the route names the object the same way. */
export type MediaVariant = "asset" | "thumbnail";

/** `{id}` canonicalised to lowercase; its shape is the route schema's to check. */
export function objectKey(mediaId: string, variant: MediaVariant): string {
  return `media/${mediaId.toLowerCase()}/${variant}`;
}
