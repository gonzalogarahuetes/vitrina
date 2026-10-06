import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { createAlbumRepository } from '../packages/server/dist/adapters/driven/postgres/album-repository.js'

/*
 * The Postgres AlbumRepository, against the live compose database.
 *
 * Belongs here and not in the hermetic suite: it needs Postgres, and
 * `pnpm test` stays Docker-free (ci.yml, job 1). Run `pnpm test` first — it
 * compiles packages/server, which this imports from dist/.
 *
 * Expected export:  createAlbumRepository(pool: Pool): AlbumRepository
 *
 * Seven properties, and the first is api-sketch §6.2's owed row:
 *   1. every wrapping and title in the list equals what was posted, byte for byte — the
 *      assertion that catches an INSERT missing the columns, or a mapper
 *      reading `wrapped_nonce` for `wrap_nonce`, neither of which any type
 *      can see and the second of which fails silently at unwrap time;
 *   2. media_count is a NUMBER, not the string node-postgres returns for
 *      bigint, and counts every row regardless of status (§9.2);
 *   3. the list is scoped to one owner, asserted with a second owner's albums
 *      present in the same table;
 *   4. a duplicate id is the PK, raised as DUPLICATE_ALBUM_ID, with the
 *      submitted title nowhere in the error (api-sketch §7.5: no request body
 *      reaches a log — ciphertext since 003, and the rule did not depend on it);
 *   5. findById carries no wrapping, because §9.4 is shared with recipients;
 *   6. the database refuses a title under the 41-byte floor (003's
 *      CHK_albums_title_len), the one length a short blob cannot recover from;
 *   7. the database does NOT cap a title: 1024 is the route's, and a database
 *      ceiling is the half of the pair 003 says not to complete.
 *
 * Isolation is by two fresh owners per run rather than by truncating, so a
 * failed run leaves the developer's database usable. Both are deleted in
 * `after`; albums and media cascade.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const pool = new Pool({ connectionString: DATABASE_URL })
const repository = createAlbumRepository(pool)

const bytes = (fill, length) => Buffer.alloc(length, fill)
const hex = (b) => Buffer.from(b).toString('hex')

const OWNER_A_EMAIL = `albums-a-${randomUUID()}@x.es`
const OWNER_B_EMAIL = `albums-b-${randomUUID()}@x.es`

let ownerA
let ownerB

/** Client-generated id, and a wrapping distinct per album so a swap shows. */
// The title is ciphertext since 003; arbitrary bytes here, as the relay never opens it.
const newAlbum = (ownerId, fill, title = bytes(0x51, 60)) => ({
	id: randomUUID(),
	ownerId,
	title,
	wrappedKey: bytes(fill, 48),
	wrapNonce: bytes(fill ^ 0xff, 24),
})

/** A media row at its default status, with the NOT NULL envelope §9.6 posts. */
async function insertMedia(albumId, status = 'pending') {
	await pool.query(
		`INSERT INTO media (id, album_id, kind, status, metadata)
		 VALUES ($1, $2, 'photo', $3, $4)`,
		[randomUUID(), albumId, status, bytes(0x09, 81)],
	)
}

const ownerIdFor = async (email) => {
	const { rows } = await pool.query('SELECT id FROM owners WHERE email = $1', [email])
	return rows[0].id
}

/** Every string reachable from an error: messages, causes, own properties. */
function stringsIn(value, found = [], seen = new Set()) {
	if (value === null || value === undefined || seen.has(value)) return found
	if (typeof value === 'string') {
		found.push(value)
		return found
	}
	if (typeof value !== 'object') return found
	seen.add(value)
	if (value instanceof Error) {
		found.push(value.message)
		stringsIn(value.cause, found, seen)
	}
	for (const v of Object.values(value)) stringsIn(v, found, seen)
	return found
}

before(async () => {
	try {
		await pool.query('SELECT 1')
	} catch (cause) {
		throw new Error(
			`cannot reach Postgres at ${DATABASE_URL}. Start the stack with ` +
				'`pnpm infra:up && pnpm infra:wait` — `up` returns once containers ' +
				'have STARTED, and the migrate one-shot races anything after it.',
			{ cause },
		)
	}

	for (const email of [OWNER_A_EMAIL, OWNER_B_EMAIL]) {
		await pool.query('INSERT INTO owners (email, auth_hash) VALUES ($1, $2)', [
			email,
			createHash('sha256').update(email).digest(),
		])
	}
	ownerA = await ownerIdFor(OWNER_A_EMAIL)
	ownerB = await ownerIdFor(OWNER_B_EMAIL)
})

after(async () => {
	await pool.query('DELETE FROM owners WHERE email = ANY($1)', [
		[OWNER_A_EMAIL, OWNER_B_EMAIL],
	])
	await pool.end()
})

test('a created album round-trips, wrapping included, byte for byte', async () => {
	/*
	 * §6.2's owed row. The two failures it exists for are both invisible to
	 * TypeScript: an INSERT that omits wrapped_key/wrap_nonce, and a mapper
	 * reading a column name that does not exist. The second returns undefined,
	 * the album lists fine, and the owner discovers it as an opaque AEAD
	 * failure on a second device.
	 */
	const album = newAlbum(ownerA, 0x42, bytes(0x52, 60))

	const created = await repository.create(album)
	assert.equal(created.id, album.id, 'the client id is the created id')
	assert.ok(created.createdAt instanceof Date, 'created_at should arrive as a Date')

	// Found by id rather than taken as the first row: this file adds more
	// albums to this owner below, and a positional read would make the test
	// depend on the order tests run in.
	const listed = (await repository.listForOwner(ownerA)).find((a) => a.id === album.id)
	assert.ok(listed, 'the created album is not in the list')
	assert.ok(listed.title instanceof Uint8Array, 'bytea should arrive as bytes, not a string')
	assert.equal(hex(listed.title), hex(album.title))
	assert.equal(hex(listed.wrappedKey), hex(album.wrappedKey))
	assert.equal(hex(listed.wrapNonce), hex(album.wrapNonce))
	assert.equal(listed.wrappedKey.length, 48)
	assert.equal(listed.wrapNonce.length, 24)
})

test('two albums keep their own wrappings', async () => {
	// One album cannot show a mapper that returns the same row twice, or a
	// query that lost the correlation between row and wrapping.
	const first = newAlbum(ownerB, 0x11)
	const second = newAlbum(ownerB, 0x22)
	await repository.create(first)
	await repository.create(second)

	const listed = await repository.listForOwner(ownerB)
	const byId = new Map(listed.map((a) => [a.id, a]))

	assert.equal(hex(byId.get(first.id).wrappedKey), hex(first.wrappedKey))
	assert.equal(hex(byId.get(second.id).wrappedKey), hex(second.wrappedKey))
	assert.notEqual(hex(first.wrappedKey), hex(second.wrappedKey))
})

test('bytea survives bytes that are not printable', async () => {
	// A plain Uint8Array handed to pg is serialised as JSON rather than as
	// bytea; a value that lost a trailing NUL fails the length assertion.
	const album = {
		...newAlbum(ownerA, 0x00),
		wrapNonce: Buffer.from([0x00, 0xff, 0x00, 0xff, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xfe, 0x00,
			0x80, 0x7f, 0x01, 0xfd, 0x10, 0x20, 0x30, 0x00]),
	}

	await repository.create(album)
	const listed = (await repository.listForOwner(ownerA)).find((a) => a.id === album.id)

	assert.equal(listed.wrapNonce.length, 24)
	assert.equal(hex(listed.wrapNonce), hex(album.wrapNonce))
})

test('media_count is a number, and counts every status', async () => {
	/*
	 * COUNT(*) is bigint and node-postgres returns bigint as a STRING. The
	 * port types mediaCount as a number, pg rows are `any`, so nothing catches
	 * "2" reaching the wire. strictEqual is the assertion; a loose one passes.
	 * §9.2 counts rows regardless of status — it is the grid's "12" label, not
	 * a count of viewable assets.
	 */
	const empty = newAlbum(ownerA, 0x31)
	const full = newAlbum(ownerA, 0x32)
	await repository.create(empty)
	await repository.create(full)
	await insertMedia(full.id, 'pending')
	await insertMedia(full.id, 'ready')
	await insertMedia(full.id, 'failed')

	const listed = await repository.listForOwner(ownerA)
	const byId = new Map(listed.map((a) => [a.id, a]))

	assert.strictEqual(byId.get(empty.id).mediaCount, 0)
	assert.strictEqual(byId.get(full.id).mediaCount, 3)
})

test('the list is ordered by created_at descending', async () => {
	// Timestamps are set explicitly: two albums created in the same test can
	// share a `now()`, and an order assertion on a tie is a flake waiting to
	// happen rather than a property.
	const older = newAlbum(ownerB, 0x51)
	const newer = newAlbum(ownerB, 0x52)
	await repository.create(older)
	await repository.create(newer)
	await pool.query('UPDATE albums SET created_at = $2 WHERE id = $1', [
		older.id,
		new Date('2026-01-01T00:00:00.000Z'),
	])
	await pool.query('UPDATE albums SET created_at = $2 WHERE id = $1', [
		newer.id,
		new Date('2026-06-01T00:00:00.000Z'),
	])

	const ids = (await repository.listForOwner(ownerB)).map((a) => a.id)
	assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id), 'newest first')
})

test('the list is scoped to one owner', async () => {
	// A WHERE that was dropped passes every assertion above, because each of
	// them looks its own album up by id.
	const mine = newAlbum(ownerA, 0x61)
	await repository.create(mine)

	const theirs = await repository.listForOwner(ownerB)
	assert.equal(
		theirs.find((a) => a.id === mine.id),
		undefined,
		"another owner's album appeared in this list",
	)
	assert.ok(theirs.length > 0, 'the assertion above would be vacuous on an empty list')
})

test('a duplicate id is DUPLICATE_ALBUM_ID, and the error names no title', async () => {
	/*
	 * §9.2's 409 means "already created": a fresh id would orphan the wrapping
	 * the client computed under the old one. No submitted value may ride into
	 * a log on a pg error's `detail`, which is where Postgres quotes it
	 * (api-sketch §7.5). The title is ciphertext since 003, so this is no
	 * longer a plaintext leak — the rule never depended on that. Postgres
	 * quotes bytea as hex, so the hex is what is searched for.
	 */
	const TITLE = bytes(0x7a, 60)
	const album = newAlbum(ownerA, 0x71, TITLE)
	await repository.create(album)

	await assert.rejects(
		() => repository.create({ ...album, title: TITLE }),
		(error) => {
			assert.equal(error.name, 'ApplicationError')
			assert.equal(error.code, 'DUPLICATE_ALBUM_ID')
			const strings = stringsIn(error)
			assert.ok(
				!strings.some((s) => s.includes(hex(TITLE))),
				`the title reached the error: ${strings.join(' | ')}`,
			)
			return true
		},
	)
})

test('findById carries ownerId and no wrapping', async () => {
	/*
	 * §9.4 is shared with recipients, so this row must not carry key-adjacent
	 * material — the wrapping is §9.2's, owner-only. Asserted on the shape, so
	 * a later `SELECT *` is a decision rather than a drift.
	 */
	const album = newAlbum(ownerA, 0x81)
	await repository.create(album)

	const row = await repository.findById(album.id)
	assert.equal(row.ownerId, ownerA)
	assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'ownerId', 'title'])
	// §9.4 returns the title to recipients too, so it is the same bytes here.
	assert.equal(hex(row.title), hex(album.title))
})

test('the database refuses a title under the 41-byte floor', async () => {
	/*
	 * 003's CHK_albums_title_len: nonce (24), one byte, tag (16). The route
	 * refuses first; this is what holds when a route forgets, because a short
	 * blob is one no client can open (encryption spec §2).
	 */
	await assert.rejects(
		() => repository.create(newAlbum(ownerA, 0x91, bytes(0x51, 40))),
		(error) => {
			assert.equal(error.code, '23514')
			assert.equal(error.constraint, 'CHK_albums_title_len')
			return true
		},
	)
	const album = newAlbum(ownerA, 0x92, bytes(0x51, 41))
	await repository.create(album)
	assert.equal(hex((await repository.findById(album.id)).title), hex(album.title))
})

test('the database does not cap a title — the ceiling is the route\'s', async () => {
	/*
	 * 003: "Do not complete the pair." 1024 is relay policy, enforced at the
	 * route where it can move without a migration. A database ceiling would
	 * turn every future raise into one. Fails the day someone adds it.
	 */
	const album = newAlbum(ownerA, 0x93, bytes(0x51, 2000))
	await repository.create(album)
	assert.equal((await repository.findById(album.id)).title.length, 2000)
})

test('an unknown album reads as null, not as an error', async () => {
	// §9.3 maps this to 404, indistinguishably from an album out of scope.
	assert.equal(await repository.findById(randomUUID()), null)
})
