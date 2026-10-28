/**
 * The check consistency.mjs runs, over injected functions so it is tested
 * without a database or a bucket (deploy/test/media-check.test.mjs).
 *
 *   listReady()    → [{ id, byteSize }]  live `ready` rows
 *   head(id, v)    → { length } | null   null = absent; throws = unknown
 *   hide(ids)      → ids actually hidden
 *
 * With `hide`, rows with an absent object are hidden (removed_at, §9.11's
 * first half) so the API omits them instead of answering 500. Decided only
 * after every row has been checked: a store that throws for any row hides
 * nothing, because "unreachable" is not "absent" (§9.7's rule for `head`).
 * A length mismatch is reported and never hidden: the object is there.
 */
export async function checkReadyMedia({ listReady, head, hide }, { hideMissing = false } = {}) {
  const rows = await listReady();
  const missing = [];
  const mismatched = [];
  for (const { id, byteSize } of rows) {
    const asset = await head(id, "asset");
    const thumbnail = await head(id, "thumbnail");
    const absent = [asset === null && "asset", thumbnail === null && "thumbnail"].filter(Boolean);
    if (absent.length) missing.push({ id, absent });
    else if (asset.length + thumbnail.length !== Number(byteSize))
      mismatched.push({ id, objects: asset.length + thumbnail.length, row: Number(byteSize) });
  }
  const hidden = hideMissing && missing.length ? await hide(missing.map((m) => m.id)) : [];
  return { checked: rows.length, missing, mismatched, hidden };
}
