import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { createAccessLogRepository } from '../packages/server/dist/adapters/driven/postgres/access-log-repository.js'

// The Postgres AccessLogRepository — api-sketch §11.6, schema §3. The route
// tests run against a fake, so only this file checks the INSERT and what a
// failed one says. Fresh owner per run; everything cascades from it in `after`.

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const pool = new Pool({ connectionString: DATABASE_URL })
const repository = createAccessLogRepository(pool)

const bytes = (fill, length) => Buffer.alloc(length, fill)
const hex = (b) => Buffer.from(b).toString('hex')
const OWNER_EMAIL = `access-log-${randomUUID()}@x.es`
const ALBUM = randomUUID()
const RECIPIENT = randomUUID()
const MEDIA = randomUUID()

const rowsFor = async (recipientId) =>
	(await pool.query('SELECT * FROM access_log WHERE recipient_id = $1 ORDER BY id', [recipientId])).rows

before(async () => {
	await pool.query('INSERT INTO owners (email, auth_hash) VALUES ($1, $2)', [
		OWNER_EMAIL,
		createHash('sha256').update(OWNER_EMAIL).digest(),
	])
	await pool.query(
		`INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce)
		 VALUES ($1, (SELECT id FROM owners WHERE email = $2), $3, $4, $5)`,
		[ALBUM, OWNER_EMAIL, bytes(0x51, 60), bytes(0x42, 48), bytes(0x43, 24)],
	)
	await pool.query(
		`INSERT INTO recipients (id, album_id, kind, label, token_hash) VALUES ($1, $2, 'qr', $3, $4)`,
		[RECIPIENT, ALBUM, bytes(0x61, 50), createHash('sha256').update(RECIPIENT).digest()],
	)
	await pool.query(
		`INSERT INTO media (id, album_id, kind, status, metadata) VALUES ($1, $2, 'photo', 'ready', $3)`,
		[MEDIA, ALBUM, bytes(0x5a, 81)],
	)
	await seedReadAlbum()
})

after(async () => {
	await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
	await pool.end()
})

test('asset_viewed writes one row: recipient, media, event, and the database\'s time', async () => {
	await pool.query('DELETE FROM access_log WHERE recipient_id = $1', [RECIPIENT])

	await repository.record({ event: 'asset_viewed', recipientId: RECIPIENT, mediaId: MEDIA })

	const rows = await rowsFor(RECIPIENT)
	assert.equal(rows.length, 1)
	assert.equal(rows[0].media_id, MEDIA)
	assert.equal(rows[0].event, 'asset_viewed')
	assert.ok(rows[0].occurred_at instanceof Date)
	assert.ok(Math.abs(rows[0].occurred_at - Date.now()) < 60_000, 'occurred_at is not now()')
})

test('album_opened writes media_id as NULL', async () => {
	await pool.query('DELETE FROM access_log WHERE recipient_id = $1', [RECIPIENT])

	await repository.record({ event: 'album_opened', recipientId: RECIPIENT })

	const [row] = await rowsFor(RECIPIENT)
	assert.equal(row.event, 'album_opened')
	assert.equal(row.media_id, null)
})

test('the same event twice is two rows — no dedupe on write', async () => {
	await pool.query('DELETE FROM access_log WHERE recipient_id = $1', [RECIPIENT])
	const event = { event: 'asset_viewed', recipientId: RECIPIENT, mediaId: MEDIA }

	await repository.record(event)
	await repository.record(event)

	const rows = await rowsFor(RECIPIENT)
	assert.equal(rows.length, 2)
	assert.ok(rows[1].id > rows[0].id, 'the id is the cursor (§11.7) and must grow')
})

test('a failed insert rejects with a message naming neither id', async () => {
	// The pg error's `detail` pairs the ids — viewing behaviour, which must not
	// reach the server log outside the table's own retention.
	const stranger = randomUUID()

	const error = await repository
		.record({ event: 'asset_viewed', recipientId: stranger, mediaId: MEDIA })
		.then(() => null, (caught) => caught)

	assert.ok(error, 'an unknown recipient must reject (FK)')
	const logged = JSON.stringify({ message: error.message, cause: error.cause, detail: error.detail })
	assert.ok(!logged.includes(stranger), 'the recipient id reached the error')
	assert.ok(!logged.includes(MEDIA), 'the media id reached the error')
	assert.match(error.message, /23503/, 'the pg code is what an operator needs')
})

// summarise and listEntries — §11.7. Their own album, so the record() tests
// above cannot disturb the counts. Rows inserted with SQL to fix occurred_at.

const READ_ALBUM = randomUUID()
const OTHER_ALBUM = randomUUID()
const MARIA = randomUUID()
const ABUELO = randomUUID() // revoked, with history
const TIA = randomUUID() // no rows at all
const STRANGER = randomUUID() // another album's recipient
const PHOTOS = [randomUUID(), randomUUID(), randomUUID()]
const OTHER_PHOTO = randomUUID()

async function addRecipient(id, albumId, createdAt, revokedAt = null) {
	await pool.query(
		`INSERT INTO recipients (id, album_id, kind, label, token_hash, created_at, revoked_at)
		 VALUES ($1, $2, 'qr', $3, $4, $5, $6)`,
		[id, albumId, bytes(0x61, 50), createHash('sha256').update(id).digest(), createdAt, revokedAt],
	)
}
const addRow = (recipientId, event, mediaId, at) =>
	pool.query(
		'INSERT INTO access_log (recipient_id, media_id, event, occurred_at) VALUES ($1, $2, $3, $4)',
		[recipientId, mediaId, event, new Date(at)],
	)

// Called from the one `before`: two root hooks started together, and this one
// raced the owner insert it depends on (measured 8 October 2026).
async function seedReadAlbum() {
	for (const id of [READ_ALBUM, OTHER_ALBUM]) {
		await pool.query(
			`INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce)
			 VALUES ($1, (SELECT id FROM owners WHERE email = $2), $3, $4, $5)`,
			[id, OWNER_EMAIL, bytes(0x51, 60), bytes(0x42, 48), bytes(0x43, 24)],
		)
	}
	await addRecipient(MARIA, READ_ALBUM, '2026-10-01T09:00:00Z')
	await addRecipient(ABUELO, READ_ALBUM, '2026-10-01T10:00:00Z', '2026-10-05T00:00:00Z')
	await addRecipient(TIA, READ_ALBUM, '2026-10-01T11:00:00Z')
	await addRecipient(STRANGER, OTHER_ALBUM, '2026-10-01T08:00:00Z')
	for (const [id, albumId] of [...PHOTOS.map((p) => [p, READ_ALBUM]), [OTHER_PHOTO, OTHER_ALBUM]]) {
		await pool.query(
			`INSERT INTO media (id, album_id, kind, status, metadata) VALUES ($1, $2, 'photo', 'ready', $3)`,
			[id, albumId, bytes(0x5a, 81)],
		)
	}

	// María: 2 opens, photo 0 twice and photo 1 once. Abuelo: 1 open, photo 2.
	await addRow(MARIA, 'album_opened', null, '2026-10-02T09:00:00Z')
	await addRow(MARIA, 'asset_viewed', PHOTOS[0], '2026-10-02T09:01:00Z')
	await addRow(MARIA, 'asset_viewed', PHOTOS[0], '2026-10-02T09:02:00Z')
	await addRow(MARIA, 'album_opened', null, '2026-10-03T09:00:00Z')
	await addRow(MARIA, 'asset_viewed', PHOTOS[1], '2026-10-03T09:01:00Z')
	await addRow(ABUELO, 'album_opened', null, '2026-10-04T09:00:00Z')
	await addRow(ABUELO, 'asset_viewed', PHOTOS[2], '2026-10-04T09:05:00Z')
	// Another album's activity, newest of all — must never appear.
	await addRow(STRANGER, 'album_opened', null, '2026-10-06T09:00:00Z')
	await addRow(STRANGER, 'asset_viewed', OTHER_PHOTO, '2026-10-06T09:01:00Z')
}

test('summarise: distinct photos, opens apart, last opened over both events', async () => {
	const summary = await repository.summarise(READ_ALBUM)
	const maria = summary.find((r) => r.recipientId === MARIA)

	assert.equal(maria.albumOpens, 2)
	assert.equal(maria.mediaOpened, 2, 'photo 0 opened twice counts once')
	assert.equal(maria.lastOpenedAt.toISOString(), '2026-10-03T09:01:00.000Z')
	assert.equal(typeof maria.albumOpens, 'number', 'pg returns COUNT as a string')
	assert.equal(hex(maria.label), hex(bytes(0x61, 50)))
})

test('summarise: a recipient with no rows appears with zeros and null', async () => {
	const tia = (await repository.summarise(READ_ALBUM)).find((r) => r.recipientId === TIA)

	assert.ok(tia, 'a zero-row recipient was dropped — an inner join, not a LEFT JOIN')
	assert.deepEqual([tia.albumOpens, tia.mediaOpened, tia.lastOpenedAt], [0, 0, null])
})

test('summarise: a revoked recipient keeps their history (§7.8)', async () => {
	const abuelo = (await repository.summarise(READ_ALBUM)).find((r) => r.recipientId === ABUELO)

	assert.equal(abuelo.revokedAt.toISOString(), '2026-10-05T00:00:00.000Z')
	assert.deepEqual([abuelo.albumOpens, abuelo.mediaOpened], [1, 1])
})

test('summarise: this album only, newest first, never-opened last', async () => {
	// The stranger's rows are the newest in the table; a missing WHERE puts
	// them first, and shows one owner another's recipients.
	const order = (await repository.summarise(READ_ALBUM)).map((r) => r.recipientId)

	assert.deepEqual(order, [ABUELO, MARIA, TIA])
})

test('listEntries: newest first by id, this album only, ids as numbers', async () => {
	const { entries, nextBefore } = await repository.listEntries({ albumId: READ_ALBUM, limit: 100 })

	assert.equal(entries.length, 7)
	assert.equal(nextBefore, null, 'exhausted means null')
	assert.ok(entries.every((e) => typeof e.id === 'number' && Number.isSafeInteger(e.id)))
	assert.deepEqual(entries.map((e) => e.id), [...entries.map((e) => e.id)].sort((a, b) => b - a))
	assert.ok(!entries.some((e) => e.recipientId === STRANGER), "another album's row appeared")
	assert.deepEqual(Object.keys(entries[0]).sort(), ['event', 'id', 'mediaId', 'occurredAt', 'recipientId'])
})

test('listEntries: pages of 3 walk every row once, and the last page ends with null', async () => {
	const seen = []
	let before
	for (let page = 0; page < 10; page++) {
		const result = await repository.listEntries({ albumId: READ_ALBUM, limit: 3, ...(before ? { before } : {}) })
		assert.ok(result.entries.length <= 3, 'a page returned its look-ahead row')
		seen.push(...result.entries.map((e) => e.id))
		if (result.nextBefore === null) break
		assert.equal(result.nextBefore, result.entries.at(-1).id)
		before = result.nextBefore
	}

	assert.equal(seen.length, 7, 'rows were skipped or repeated across pages')
	assert.equal(new Set(seen).size, 7)
})

test('listEntries: exactly limit rows left is one page, not a page and an empty one', async () => {
	// The limit + 1 look-ahead: without it, a full last page cannot know it is last.
	const { entries, nextBefore } = await repository.listEntries({ albumId: READ_ALBUM, limit: 7 })

	assert.equal(entries.length, 7)
	assert.equal(nextBefore, null)
})

test('listEntries: each filter alone, and both together', async () => {
	const byRecipient = await repository.listEntries({ albumId: READ_ALBUM, recipientId: MARIA, limit: 100 })
	assert.equal(byRecipient.entries.length, 5)
	assert.ok(byRecipient.entries.every((e) => e.recipientId === MARIA))

	const byMedia = await repository.listEntries({ albumId: READ_ALBUM, mediaId: PHOTOS[0], limit: 100 })
	assert.equal(byMedia.entries.length, 2)

	const both = await repository.listEntries({ albumId: READ_ALBUM, recipientId: ABUELO, mediaId: PHOTOS[2], limit: 100 })
	assert.equal(both.entries.length, 1)
	assert.equal(both.entries[0].event, 'asset_viewed')
})

test("listEntries: another album's recipient as a filter answers empty, not their rows", async () => {
	const { entries } = await repository.listEntries({ albumId: READ_ALBUM, recipientId: STRANGER, limit: 100 })

	assert.deepEqual(entries, [])
})
