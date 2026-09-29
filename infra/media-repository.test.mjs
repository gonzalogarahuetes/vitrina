import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { createMediaRepository } from '../packages/server/dist/adapters/driven/postgres/media-repository.js'

/*
 * The Postgres MediaRepository, against the live compose database.
 *
 * Belongs here and not in the hermetic suite: it needs Postgres, and
 * `pnpm test` stays Docker-free (ci.yml, job 1). Run `pnpm test` first — it
 * compiles packages/server, which this imports from dist/.
 *
 * Expected export:  createMediaRepository(pool: Pool): MediaRepository
 *
 * This file is where §9.7's ladder is actually enforced. The port names one
 * method per legal edge so an illegal transition is inexpressible in
 * TypeScript; what only a database can show is that each method's WHERE
 * clause agrees — that markReady from `pending` writes nothing, that
 * beginUpload refuses a `ready` row, and that the three outcomes it reports
 * are distinguishable. Also here:
 *   - metadata round-trips as bytea, byte for byte (a plain Uint8Array is
 *     serialised as JSON and the envelope comes back undecryptable);
 *   - byte_size is a NUMBER, not the string node-postgres returns for bigint;
 *   - §9.4 lists every row and §9.5 returns only `ready` envelopes — the pair
 *     §6.2 owes, asserted together because the two filter differently on
 *     purpose and either alone proves nothing.
 *
 * Isolation is by a fresh owner per run rather than by truncating, so a failed
 * run leaves the developer's database usable. The owner is deleted in `after`
 * and albums and media cascade.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const pool = new Pool({ connectionString: DATABASE_URL })
const repository = createMediaRepository(pool)

const bytes = (fill, length) => Buffer.alloc(length, fill)
const hex = (b) => Buffer.from(b).toString('hex')

const OWNER_EMAIL = `media-${randomUUID()}@x.es`
const ALBUM = randomUUID()
const OTHER_ALBUM = randomUUID()

let ownerId

/** The smallest legal envelope: 64-byte header, one byte, a 16-byte tag. */
const envelope = (fill) => bytes(fill, 81)

const newMedia = (albumId, fill) => ({
	id: randomUUID(),
	albumId,
	kind: 'photo',
	metadata: envelope(fill),
})

const statusOf = async (mediaId) => {
	const { rows } = await pool.query('SELECT status FROM media WHERE id = $1', [mediaId])
	return rows[0]?.status ?? null
}

/** Moves a row to a state no repository method reaches directly. */
const forceStatus = (mediaId, status) =>
	pool.query('UPDATE media SET status = $2 WHERE id = $1', [mediaId, status])

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

	await pool.query('INSERT INTO owners (email, auth_hash) VALUES ($1, $2)', [
		OWNER_EMAIL,
		createHash('sha256').update(OWNER_EMAIL).digest(),
	])
	const { rows } = await pool.query('SELECT id FROM owners WHERE email = $1', [OWNER_EMAIL])
	ownerId = rows[0].id

	for (const id of [ALBUM, OTHER_ALBUM]) {
		await pool.query(
			`INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce)
			 VALUES ($1, $2, $3, $4, $5)`,
			[id, ownerId, 'Álbum de prueba', bytes(0x42, 48), bytes(0x43, 24)],
		)
	}
})

after(async () => {
	await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
	await pool.end()
})

test('create returns the row at pending, read from the column', async () => {
	// §9.6's 201 reports `status`; it must be the column the default set, not a
	// literal the route asserted — no route writes a status string (§9.7).
	const media = newMedia(ALBUM, 0x01)

	const created = await repository.create(media)

	assert.equal(created.id, media.id, 'the client id is the created id')
	assert.equal(created.status, 'pending')
	assert.ok(created.createdAt instanceof Date, 'created_at should arrive as a Date')
})

test('the metadata envelope round-trips as bytea, byte for byte', async () => {
	/*
	 * A plain Uint8Array handed to pg is serialised as JSON, not as bytea, and
	 * the envelope comes back undecryptable with nothing complaining until a
	 * client tries to open it. Non-printable bytes and a trailing NUL are what
	 * make that visible.
	 */
	const metadata = Buffer.concat([
		Buffer.from([0x00, 0xff, 0x7f, 0x80, 0xfe, 0x01]),
		bytes(0x5a, 74),
		Buffer.from([0x00]),
	])
	assert.equal(metadata.length, 81, 'fixture is not a minimum-length envelope')
	const media = { ...newMedia(ALBUM, 0x02), metadata }

	await repository.create(media)
	await forceStatus(media.id, 'ready')
	// Found by id: later tests add ready rows to this album, and a positional
	// read would make this depend on the order tests run in.
	const row = (await repository.listReadyEnvelopes(ALBUM)).find(
		(candidate) => candidate.mediaId === media.id,
	)

	assert.ok(row, 'the ready row is missing from the envelope list')
	assert.equal(row.envelope.length, 81)
	assert.equal(hex(row.envelope), hex(metadata))
})

test('a duplicate id is DUPLICATE_MEDIA_ID, and the error quotes no value', async () => {
	// §9.6's 409 means "already created": a new id would orphan the envelope
	// the client already encrypted under the old one.
	const media = newMedia(ALBUM, 0x03)
	await repository.create(media)

	await assert.rejects(
		() => repository.create(media),
		(error) => {
			assert.equal(error.name, 'ApplicationError')
			assert.equal(error.code, 'DUPLICATE_MEDIA_ID')
			// Postgres puts the submitted value in `detail`, which errWithCause
			// copies; chaining the driver error rather than a written message
			// is what this catches.
			const strings = stringsIn(error)
			assert.ok(
				!strings.some((s) => s.includes(media.id)),
				`the id reached the error: ${strings.join(' | ')}`,
			)
			return true
		},
	)
})

test('findById carries ownerId from the album join', async () => {
	// `media` has no owner_id column — §9.3 resolves media scope through the
	// join, and a query without it is 42703 and a 500 on every status request.
	const media = newMedia(ALBUM, 0x04)
	await repository.create(media)

	const row = await repository.findById(media.id)

	assert.equal(row.ownerId, ownerId)
	assert.equal(row.albumId, ALBUM)
	assert.equal(row.kind, 'photo')
	assert.equal(row.status, 'pending')
	assert.equal(row.byteSize, null, 'null before ready, not 0 and not undefined')
	assert.ok(row.updatedAt instanceof Date)
})

test('an unknown media row reads as null, not as an error', async () => {
	assert.equal(await repository.findById(randomUUID()), null)
})

test('byte_size comes back as a number, not a bigint string', async () => {
	/*
	 * `byte_size` is bigint and node-postgres returns bigint as a STRING. The
	 * port types it `number | null`, §9.8 puts it on the wire as an integer,
	 * and pg rows are `any` — so nothing but this catches "1048576".
	 */
	const media = newMedia(ALBUM, 0x05)
	await repository.create(media)
	await repository.beginUpload(media.id)
	await repository.markReady(media.id, 1048576)

	const row = await repository.findById(media.id)

	assert.strictEqual(row.byteSize, 1048576)
})

test('§9.4 lists every row whatever its status, oldest first', async () => {
	// The other half of the pair below. A recipient's client hides what is not
	// ready; that filter is the client's, because a video in `processing` for
	// three minutes must not vanish from the owner's grid (#9).
	const pending = newMedia(OTHER_ALBUM, 0x11)
	const ready = newMedia(OTHER_ALBUM, 0x12)
	const failed = newMedia(OTHER_ALBUM, 0x13)
	for (const media of [pending, ready, failed]) await repository.create(media)
	await forceStatus(ready.id, 'ready')
	await forceStatus(failed.id, 'failed')

	const listed = await repository.listByAlbum(OTHER_ALBUM)
	const ids = listed.map((row) => row.id)

	assert.deepEqual(ids, [pending.id, ready.id, failed.id], 'created_at ascending')
	assert.deepEqual(
		listed.map((row) => row.status).sort(),
		['failed', 'pending', 'ready'],
	)
})

test('§9.5 returns only ready rows, and the pair is the assertion', async () => {
	/*
	 * §6.2's owed row. A `pending` row's envelope was posted at create and
	 * describes an asset that does not exist yet; handing it out invites a
	 * client to lay out a cell it cannot fill. Asserted against §9.4's listing
	 * of the same album, because either test alone would pass a repository
	 * that filtered everywhere or nowhere.
	 */
	const envelopes = await repository.listReadyEnvelopes(OTHER_ALBUM)
	const listing = await repository.listByAlbum(OTHER_ALBUM)

	assert.equal(listing.length, 3, 'the listing is what makes this non-vacuous')
	assert.equal(envelopes.length, 1)
	assert.equal(
		envelopes[0].mediaId,
		listing.find((row) => row.status === 'ready').id,
	)
})

test('beginUpload moves pending to processing and reports it', async () => {
	const media = newMedia(ALBUM, 0x21)
	await repository.create(media)

	assert.equal(await repository.beginUpload(media.id), 'started')
	assert.equal(await statusOf(media.id), 'processing')
})

test('beginUpload is legal from failed and from processing', async () => {
	// §9.7's fourth edge, and a re-upload mid-flight. Both are the client's
	// latest attempt, and refusing either would strand a row nothing can move.
	const media = newMedia(ALBUM, 0x22)
	await repository.create(media)
	await forceStatus(media.id, 'failed')

	assert.equal(await repository.beginUpload(media.id), 'started')
	assert.equal(await statusOf(media.id), 'processing')
	assert.equal(await repository.beginUpload(media.id), 'started', 'processing again')
})

test('beginUpload refuses a ready row and leaves it alone', async () => {
	// §9.7's 409, and the check "PUT is idempotent" removes. After `ready`,
	// replacing an object a recipient may be mid-fetch on is editing, and v1
	// has no album editing.
	const media = newMedia(ALBUM, 0x23)
	await repository.create(media)
	await forceStatus(media.id, 'ready')

	assert.equal(await repository.beginUpload(media.id), 'already_ready')
	assert.equal(await statusOf(media.id), 'ready', 'the row must not have moved')
})

test('beginUpload on an absent row is null, which is a 404 and not a 409', async () => {
	// The two zero-row cases are different statuses, which is why the query
	// reports existence separately rather than counting updated rows.
	assert.equal(await repository.beginUpload(randomUUID()), null)
})

test('beginUpload moves updated_at forward', async () => {
	// §9.7's stall case has nothing but `updated_at` to look at, and nothing
	// reads it yet — which makes it the line that gets dropped.
	const media = newMedia(ALBUM, 0x24)
	await repository.create(media)
	const stale = new Date('2026-01-01T00:00:00.000Z')
	await pool.query('UPDATE media SET updated_at = $2 WHERE id = $1', [media.id, stale])

	await repository.beginUpload(media.id)

	const row = await repository.findById(media.id)
	assert.ok(row.updatedAt > stale, 'updated_at did not move')
})

test('markReady writes only from processing', async () => {
	/*
	 * The guard that makes `pending → ready` inexpressible. Without it, a
	 * handler that confirmed one object could mark a row whose upload never
	 * started, and `ready` would stop meaning both objects exist.
	 */
	const media = newMedia(ALBUM, 0x31)
	await repository.create(media)

	await repository.markReady(media.id, 999)

	assert.equal(await statusOf(media.id), 'pending', 'pending must not reach ready')
	assert.equal((await repository.findById(media.id)).byteSize, null)
})

test('markReady from processing sets the status and the byte size', async () => {
	const media = newMedia(ALBUM, 0x32)
	await repository.create(media)
	await repository.beginUpload(media.id)

	await repository.markReady(media.id, 4096)

	const row = await repository.findById(media.id)
	assert.equal(row.status, 'ready')
	assert.strictEqual(row.byteSize, 4096)
})

test('markFailed writes only from processing', async () => {
	// A `ready` row is not reachable by `failed`: §9.7's table has no such
	// edge, and a row that went backwards would break what `ready` promises.
	const media = newMedia(ALBUM, 0x33)
	await repository.create(media)
	await forceStatus(media.id, 'ready')

	await repository.markFailed(media.id)

	assert.equal(await statusOf(media.id), 'ready')
})

test('markFailed from processing is the recoverable direction', async () => {
	// `failed → processing` is legal, so a client can re-upload; this asserts
	// the row reaches `failed` at all, and the test above that it can return.
	const media = newMedia(ALBUM, 0x34)
	await repository.create(media)
	await repository.beginUpload(media.id)

	await repository.markFailed(media.id)

	assert.equal(await statusOf(media.id), 'failed')
	assert.equal(await repository.beginUpload(media.id), 'started')
})
