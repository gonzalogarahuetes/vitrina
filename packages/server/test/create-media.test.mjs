/*
 * §9.6's media create, and the first implementation of §9.3's scope
 * resolution — api-sketch §9.3, §9.6, brief §9.1.
 * The row is the media repository's business and has its own infra tests; what
 * is asserted here is the check in front of it: that "album absent" and "album
 * is someone else's" are one answer, and that nothing is written when it fails.
 * Hermetic: fake repositories, no Postgres.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMedia } from "../dist/application/use-cases/create-media.js";
import { ApplicationError } from "../dist/application/errors.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const ALBUM = "33333333-3333-4333-8333-333333333333";
const MEDIA = "44444444-4444-4444-8444-444444444444";

/** The smallest legal envelope: 64-byte header, one byte, a 16-byte tag. */
const METADATA = new Uint8Array(81).fill(0x5a);

const input = (overrides = {}) => ({
  id: MEDIA,
  albumId: ALBUM,
  kind: "photo",
  metadata: METADATA,
  ownerId: OWNER,
  ...overrides,
});

/** Records what it was handed, so the assertions can look at the call. */
function spyMedia(onCreate) {
  const calls = [];
  return {
    calls,
    async create(media) {
      calls.push(media);
      if (onCreate) return onCreate(media);
      return {
        id: media.id,
        createdAt: new Date("2026-09-24T09:00:00.000Z"),
        status: "pending",
      };
    },
  };
}

const albumsReturning = (album) => ({
  async findById() {
    return album;
  },
});

const ownedAlbum = {
  id: ALBUM,
  ownerId: OWNER,
  title: "Primer cumpleaños",
  createdAt: new Date("2026-09-21T09:00:00.000Z"),
};

describe("createMedia — §9.6", () => {
  it("creates the row when the album is the caller's", async () => {
    const media = spyMedia();
    const created = await createMedia({ albums: albumsReturning(ownedAlbum), media })(input());

    assert.equal(created.id, MEDIA);
    // §9.6's 201 reports the column, never a literal the route asserted.
    assert.equal(created.status, "pending");
  });

  it("writes the row and not the caller", async () => {
    /*
     * `media` has no owner_id column — the album owns the media. `ownerId` is
     * an input to the check and must not reach the insert, which the port
     * cannot enforce because structural typing accepts the extra property.
     */
    const media = spyMedia();
    await createMedia({ albums: albumsReturning(ownedAlbum), media })(input());

    assert.equal(media.calls.length, 1);
    assert.deepEqual(Object.keys(media.calls[0]).sort(), [
      "albumId",
      "id",
      "kind",
      "metadata",
    ]);
  });

  it("passes the envelope through untouched", async () => {
    // §9.1's format-blindness: the relay does not parse the header, check
    // `VTRN`, or verify that `asset_id` at offset 36 equals the media id.
    const media = spyMedia();
    await createMedia({ albums: albumsReturning(ownedAlbum), media })(input());

    assert.equal(media.calls[0].metadata, METADATA);
  });

  describe("§9.3 — absent and not-yours are one answer", () => {
    const outOfScope = [
      ["the album does not exist", null],
      ["the album belongs to another owner", { ...ownedAlbum, ownerId: OTHER_OWNER }],
    ];

    for (const [name, album] of outOfScope) {
      it(`throws ALBUM_NOT_FOUND when ${name}`, async () => {
        const media = spyMedia();

        await assert.rejects(
          () => createMedia({ albums: albumsReturning(album), media })(input()),
          (error) => {
            assert.ok(error instanceof ApplicationError);
            assert.equal(error.code, "ALBUM_NOT_FOUND");
            return true;
          },
        );
      });
    }

    it("throws the identical error for both, which is the whole rule", async () => {
      /*
       * A `403` for the second case would confirm the album exists — brief
       * §9.1's easiest way to leak album access, and the reason both branches
       * are one condition rather than two throw sites that happen to agree.
       * Comparing the errors is what fails the day someone splits them.
       */
      const thrown = [];
      for (const [, album] of outOfScope) {
        await createMedia({ albums: albumsReturning(album), media: spyMedia() })(
          input(),
        ).catch((error) => thrown.push(error));
      }

      assert.equal(thrown.length, 2);
      assert.equal(thrown[0].code, thrown[1].code);
      assert.equal(thrown[0].message, thrown[1].message);
      assert.equal(thrown[0].constructor, thrown[1].constructor);
    });

    it("writes nothing when the scope check fails", async () => {
      // The check has to precede the insert, not accompany it: a row created
      // and then rejected is a row in someone else's album.
      const media = spyMedia();

      await createMedia({ albums: albumsReturning(null), media })(input()).catch(() => {});

      assert.deepEqual(media.calls, []);
    });
  });

  it("lets a duplicate id through as the repository raised it", async () => {
    /*
     * §9.6's 409 comes from the primary key, and this use case must not catch
     * it: a `try/catch` here could only rethrow, and one that translated it
     * would be a second place deciding what a duplicate means.
     */
    const media = spyMedia(() => {
      throw new ApplicationError("DUPLICATE_MEDIA_ID");
    });

    await assert.rejects(
      () => createMedia({ albums: albumsReturning(ownedAlbum), media })(input()),
      (error) => error.code === "DUPLICATE_MEDIA_ID",
    );
  });
});
