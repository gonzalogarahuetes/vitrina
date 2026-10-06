import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { createRecipientRepository } from '../packages/server/dist/adapters/driven/postgres/recipient-repository.js'

/*
 * The Postgres RecipientRepository, against the live compose database.
 *
 * Belongs here and not in the hermetic suite: it needs Postgres, and
 * `pnpm test` stays Docker-free (ci.yml, job 1). Run `pnpm test` first — it
 * compiles packages/server, which this imports from dist/.
 *
 * Expected export:  createRecipientRepository(pool: Pool): RecipientRepository
 *
 * Four properties the port promises and only a real database can show, and
 * a fifth that is the table's rather than the port's:
 *   1. token_hash round-trips as bytea and the lookup matches byte for byte —
 *      a Uint8Array serialised as JSON rather than as bytea fails here;
 *   2. a REVOKED row comes back with revokedAt set rather than being filtered
 *      (api-sketch §7.3: scope is step 3, revocation step 4) — the property
 *      the whole recipient chain was restructured around;
 *   3. the row carries exactly id, albumId and revokedAt, so a later widening
 *      into §10.1's wrapped/kdf columns is a deliberate change, not drift;
 *   4. UQ_recipients_token_hash makes the lookup unambiguous, asserted by
 *      watching a duplicate insert fail rather than by trusting the schema;
 *   5. label is ciphertext since 003, and the database refuses one under the
 *      41-byte floor (CHK_recipients_label_len) while setting no ceiling.
 *
 * The fixtures above are inserted with SQL so the lookup tests stand apart
 * from create. Create, scope and revoke (§7.7, §7.8) follow at the foot of
 * the file, and they read the table back directly rather than through the
 * port, so a write that went to the wrong table or matched no row cannot pass
 * by agreeing with its own read.
 *
 * Isolation is by a fresh owner per run rather than by truncating, so a failed
 * run leaves the developer's database usable. The owner is deleted in `after`
 * and albums and recipients cascade.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const pool = new Pool({ connectionString: DATABASE_URL })
const repository = createRecipientRepository(pool)

const bytes = (fill, length) => Buffer.alloc(length, fill)
const hex = (b) => Buffer.from(b).toString('hex')

/** Schema §6: SHA-256 over the 32 RAW token bytes, never over an encoding. */
const tokenHash = (token) => createHash('sha256').update(token).digest()

const OWNER_EMAIL = `recipients-${randomUUID()}@x.es`

/** Two albums, so "albumId came from the row" is a real assertion. */
const ALBUM_A = randomUUID()
const ALBUM_B = randomUUID()

const REVOKED_AT = new Date('2026-09-20T10:00:00.000Z')

/** Client-generated ids and their tokens — §7.4, the client mints these. */
const live = { id: randomUUID(), token: bytes(0x01, 32), albumId: ALBUM_A }
const revoked = { id: randomUUID(), token: bytes(0x02, 32), albumId: ALBUM_A }
const other = { id: randomUUID(), token: bytes(0x03, 32), albumId: ALBUM_B }

async function insertAlbum(id) {
	await pool.query(
		`INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce)
		 VALUES ($1, (SELECT id FROM owners WHERE email = $2), $3, $4, $5)`,
		[id, OWNER_EMAIL, bytes(0x51, 60), bytes(0x42, 48), bytes(0x43, 24)], // title: ciphertext since 003
	)
}

/** A QR recipient: the six passphrase columns stay NULL (§6.2, CK constraint). */
async function insertRecipient({ id, token, albumId, label = bytes(0x61, 50) }, revokedAt = null) {
	await pool.query(
		`INSERT INTO recipients (id, album_id, kind, label, token_hash, revoked_at)
		 VALUES ($1, $2, 'qr', $3, $4, $5)`,
		[id, albumId, label, tokenHash(token), revokedAt], // label: ciphertext since 003
	)
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

	await pool.query(
		'INSERT INTO owners (email, auth_hash) VALUES ($1, $2)',
		[OWNER_EMAIL, createHash('sha256').update(OWNER_EMAIL).digest()],
	)
	await insertAlbum(ALBUM_A)
	await insertAlbum(ALBUM_B)
	await insertRecipient(live)
	await insertRecipient(revoked, REVOKED_AT)
	await insertRecipient(other)
})

after(async () => {
	await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
	await pool.end()
})

test('a live grant round-trips, keyed on the raw hash bytes', async () => {
	const grant = await repository.findGrantByTokenHash(tokenHash(live.token))

	assert.ok(grant, 'no row for a hash that was inserted')
	assert.equal(grant.id, live.id)
	assert.equal(grant.albumId, ALBUM_A)
	assert.equal(grant.revokedAt, null, 'a live row must be null, not undefined')
})

test('the hash is matched byte for byte, not by coincidence', async () => {
	// One bit flipped in the last byte. A lookup that stringified the
	// parameter, or compared a prefix, answers the live row here.
	const almost = Buffer.from(tokenHash(live.token))
	almost[almost.length - 1] ^= 0x01

	assert.notEqual(hex(almost), hex(tokenHash(live.token)))
	assert.equal(await repository.findGrantByTokenHash(almost), null)
})

test('an unknown hash reads as null, not as an error', async () => {
	// §7.3 step 1 maps this to 401; a throw would be a 500 for every caller
	// presenting a stale invite.
	assert.equal(await repository.findGrantByTokenHash(bytes(0xee, 32)), null)
})

test('a REVOKED row comes back, with revokedAt set', async () => {
	/*
	 * The assertion this file exists for. §7.3 resolves scope at step 3 and
	 * revocation at step 4, so a revoked recipient asking for their own album
	 * gets 403 and one probing another gets 404 — both impossible if the
	 * repository filters. The natural `WHERE revoked_at IS NULL` makes this
	 * null and ACCESS_REVOKED unreachable.
	 */
	const grant = await repository.findGrantByTokenHash(tokenHash(revoked.token))

	assert.ok(grant, 'a revoked row must still be found — see §7.3 step 4')
	assert.equal(grant.id, revoked.id)
	assert.ok(grant.revokedAt instanceof Date, 'revoked_at should arrive as a Date')
	assert.equal(grant.revokedAt.toISOString(), REVOKED_AT.toISOString())
})

test('albumId comes from the row, not from the caller', async () => {
	// Two albums under one owner: a query that joined wrongly, or returned a
	// constant, passes every test above and fails this one.
	const a = await repository.findGrantByTokenHash(tokenHash(live.token))
	const b = await repository.findGrantByTokenHash(tokenHash(other.token))

	assert.equal(a.albumId, ALBUM_A)
	assert.equal(b.albumId, ALBUM_B)
	assert.notEqual(a.albumId, b.albumId)
})

test('the grant carries exactly three fields', async () => {
	/*
	 * §10.1's wrapped, wrap_nonce, kdf_salt and the three Argon2id parameters
	 * are PR 4's and get their own method — a query that never selects them
	 * has none to hand out. Asserted on the shape so widening this row is a
	 * decision someone makes here rather than one that arrives with a `SELECT *`.
	 */
	const grant = await repository.findGrantByTokenHash(tokenHash(live.token))

	assert.deepEqual(Object.keys(grant).sort(), ['albumId', 'id', 'revokedAt'])
})

test('UQ_recipients_token_hash makes the lookup unambiguous', async () => {
	// The reason `rows: [row]` is correct rather than lucky. Asserted against
	// the live database, because it is the constraint and not the code that
	// guarantees it.
	await assert.rejects(
		() => insertRecipient({ id: randomUUID(), token: live.token, albumId: ALBUM_B }),
		(error) => error.code === '23505',
	)
})

test('label is refused under the 41-byte floor, and not capped above', async () => {
	/*
	 * 003's CHK_recipients_label_len. The floor only: 1024 belongs to §7.7's
	 * route, not the table, so a 2000-byte label is the database's to accept.
	 */
	const fresh = (label) => ({
		id: randomUUID(),
		token: randomBytes(32),
		albumId: ALBUM_B,
		label,
	})

	await assert.rejects(
		() => insertRecipient(fresh(bytes(0x61, 40))),
		(error) => error.code === '23514' && error.constraint === 'CHK_recipients_label_len',
	)
	await insertRecipient(fresh(bytes(0x61, 41)))
	await insertRecipient(fresh(bytes(0x61, 2000)))
})

/*
 * Create, scope and revoke — api-sketch §7.7 and §7.8.
 */

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

/** A QR recipient as the port takes it, every binary field distinct. */
const newQr = (overrides = {}) => ({
	id: randomUUID(),
	albumId: ALBUM_A,
	kind: 'qr',
	label: Buffer.from([0x00, 0xff, ...bytes(0x6c, 46), 0xff, 0x00]), // 50, NUL at both ends
	tokenHash: tokenHash(randomBytes(32)),
	...overrides,
})

/** A passphrase recipient, at 002's floors so the test pins which migration's. */
const newPassphrase = (overrides = {}) => ({
	...newQr(),
	kind: 'passphrase',
	wrap: {
		wrapped: bytes(0x77, 48),
		wrapNonce: bytes(0x6e, 24),
		kdfSalt: bytes(0x73, 16),
		params: { memoryKib: 16384, iterations: 2, parallelism: 1 },
	},
	...overrides,
})

async function rowOf(id) {
	const { rows } = await pool.query('SELECT * FROM recipients WHERE id = $1', [id])
	assert.equal(rows.length, 1, `expected exactly one recipients row for ${id}`)
	return rows[0]
}

const PASSPHRASE_COLUMNS = [
	'wrapped',
	'wrap_nonce',
	'kdf_salt',
	'kdf_memory_kib',
	'kdf_iterations',
	'kdf_parallelism',
]

test('create: a QR recipient lands in recipients, with no wrap columns', async () => {
	const recipient = newQr()
	const created = await repository.create(recipient)

	assert.equal(created.id, recipient.id, 'the id is the client\'s, never the server\'s (§7.7)')
	assert.ok(created.createdAt instanceof Date)
	assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'id'])

	const row = await rowOf(recipient.id)
	assert.equal(row.album_id, ALBUM_A)
	assert.equal(row.kind, 'qr')
	assert.equal(hex(row.label), hex(recipient.label), 'label is bytea, byte for byte')
	assert.equal(hex(row.token_hash), hex(recipient.tokenHash))
	assert.equal(row.revoked_at, null)
	for (const column of PASSPHRASE_COLUMNS) {
		assert.equal(row[column], null, `${column} is set on a QR row`)
	}
	assert.equal(row.created_at.toISOString(), created.createdAt.toISOString())
})

test('create: a passphrase recipient stores all six wrap columns', async () => {
	// The eleven-column insert. Its placeholder count is what broke first.
	const recipient = newPassphrase()
	await repository.create(recipient)

	const row = await rowOf(recipient.id)
	assert.equal(row.kind, 'passphrase')
	assert.equal(hex(row.wrapped), hex(recipient.wrap.wrapped))
	assert.equal(hex(row.wrap_nonce), hex(recipient.wrap.wrapNonce))
	assert.equal(hex(row.kdf_salt), hex(recipient.wrap.kdfSalt))
	assert.equal(row.kdf_memory_kib, 16384)
	assert.equal(row.kdf_iterations, 2)
	assert.equal(row.kdf_parallelism, 1)
})

test('create: a created recipient is a usable credential', async () => {
	// The point of the route: PR 4 needs rows the tests did not write by hand.
	const token = randomBytes(32)
	const recipient = newPassphrase({ tokenHash: tokenHash(token), albumId: ALBUM_B })
	await repository.create(recipient)

	const grant = await repository.findGrantByTokenHash(tokenHash(token))
	assert.equal(grant.id, recipient.id)
	assert.equal(grant.albumId, ALBUM_B)
	assert.equal(grant.revokedAt, null)
})

test('create: KDF floors are 002\'s, not 001\'s', async () => {
	// 16384/2/1 is accepted above. One below the memory floor is the
	// database's to refuse — and must NOT surface as DUPLICATE_RECIPIENT.
	const below = newPassphrase()
	below.wrap = { ...below.wrap, params: { ...below.wrap.params, memoryKib: 16383 } }

	await assert.rejects(
		() => repository.create(below),
		(error) => error.code === '23514' && error.constraint === 'CHK_recipients_kdf_wrap_kind',
	)
})

test('create: a duplicate id is DUPLICATE_RECIPIENT, naming nothing submitted', async () => {
	const first = newQr()
	await repository.create(first)
	const retry = newQr({ id: first.id })

	await assert.rejects(
		() => repository.create(retry),
		(error) => {
			assert.equal(error.code, 'DUPLICATE_RECIPIENT')
			// #15: pg's `detail` carries the colliding key. A cause chained
			// verbatim puts the id here, or on the hash case the hash.
			for (const string of stringsIn(error)) {
				assert.ok(!string.includes(first.id), `the id reached the error: ${string}`)
				assert.ok(!string.includes(hex(retry.tokenHash)), `the hash reached the error: ${string}`)
			}
			return true
		},
	)
	await rowOf(first.id) // still exactly one
})

test('create: a duplicate token_hash is DUPLICATE_RECIPIENT too, with its own log cause', async () => {
	/*
	 * The case that answered 500 before UQ_recipients_token_hash was matched.
	 * Same wire code as the id collision (§7.7: naming the column is an
	 * oracle), but a DIFFERENT authored cause, so the log can still say which
	 * one collided — the diagnostic the album and media codes keep.
	 */
	const first = newQr()
	await repository.create(first)
	const squatter = newQr({ tokenHash: first.tokenHash })

	const idCollision = await repository.create(newQr({ id: first.id })).catch((e) => e)
	const hashCollision = await repository.create(squatter).catch((e) => e)

	assert.equal(hashCollision.code, 'DUPLICATE_RECIPIENT')
	for (const string of stringsIn(hashCollision)) {
		assert.ok(!string.includes(hex(first.tokenHash)), `the hash reached the error: ${string}`)
	}
	assert.notEqual(
		hashCollision.cause?.message,
		idCollision.cause?.message,
		'the two collisions are indistinguishable in the log',
	)

	const { rows } = await pool.query('SELECT count(*)::int AS n FROM recipients WHERE id = $1', [
		squatter.id,
	])
	assert.equal(rows[0].n, 0)
})

test('create: an unknown album is not a duplicate', async () => {
	// 23503, not 23505. The use case scopes first so the route never sends
	// this; if it ever does, it must reach the 500 path with its stack.
	await assert.rejects(
		() => repository.create(newQr({ albumId: randomUUID() })),
		(error) => error.code === '23503',
	)
})

test('findScopeById: id, album and the album\'s owner — and nothing else', async () => {
	const scope = await repository.findScopeById(live.id)
	const { rows: [owner] } = await pool.query('SELECT id FROM owners WHERE email = $1', [OWNER_EMAIL])

	assert.deepEqual(scope, { id: live.id, albumId: ALBUM_A, ownerId: owner.id })
})

test('findScopeById: a revoked recipient is still in scope; an unknown one is null', async () => {
	// Revoke is idempotent (§7.8): a second revoke must find the row, so the
	// scope lookup must not filter on revocation.
	const scope = await repository.findScopeById(revoked.id)
	assert.equal(scope.id, revoked.id)
	assert.equal(await repository.findScopeById(randomUUID()), null)
})

test('revoke: sets revoked_at, and returns the original on every later call', async () => {
	const recipient = newQr()
	await repository.create(recipient)

	const first = await repository.revoke(recipient.id)
	assert.ok(first instanceof Date)
	await new Promise((resolve) => setTimeout(resolve, 20))
	const second = await repository.revoke(recipient.id)

	assert.equal(second.toISOString(), first.toISOString(), 'a second revoke moved the timestamp')
	assert.equal((await rowOf(recipient.id)).revoked_at.toISOString(), first.toISOString())
})

test('revoke: a row revoked earlier keeps its timestamp', async () => {
	const at = await repository.revoke(revoked.id)
	assert.equal(at.toISOString(), REVOKED_AT.toISOString())
})

test('revoke: two concurrent revokes return the same timestamp', async () => {
	// COALESCE inside the UPDATE: the second blocks on the row lock,
	// re-reads it under READ COMMITTED, and keeps the first value. A
	// read-then-write implementation can return two different timestamps.
	const recipient = newQr()
	await repository.create(recipient)

	const [a, b] = await Promise.all([
		repository.revoke(recipient.id),
		repository.revoke(recipient.id),
	])
	assert.equal(a.toISOString(), b.toISOString())
})

test('revoke: deletes nothing — the access log survives', async () => {
	/*
	 * §7.8's whole argument. access_log.recipient_id is ON DELETE CASCADE, so a
	 * revoke implemented as DELETE takes "María viewed this" with it.
	 */
	const recipient = newQr()
	await repository.create(recipient)
	await pool.query(
		`INSERT INTO access_log (recipient_id, event) VALUES ($1, 'album_opened'), ($1, 'album_opened')`,
		[recipient.id],
	)

	await repository.revoke(recipient.id)

	await rowOf(recipient.id)
	const { rows } = await pool.query(
		'SELECT count(*)::int AS n FROM access_log WHERE recipient_id = $1',
		[recipient.id],
	)
	assert.equal(rows[0].n, 2, 'revoke destroyed the view history')
})

test('revoke: an unknown id throws rather than returning undefined', async () => {
	// The use case scopes first, so this is unreachable from the route. If it
	// is ever reached it must be a 500, never a 200 with no revoked_at.
	await assert.rejects(() => repository.revoke(randomUUID()))
})
