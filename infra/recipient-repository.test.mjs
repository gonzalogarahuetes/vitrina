import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
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
 * Four properties the port promises and only a real database can show:
 *   1. token_hash round-trips as bytea and the lookup matches byte for byte —
 *      a Uint8Array serialised as JSON rather than as bytea fails here;
 *   2. a REVOKED row comes back with revokedAt set rather than being filtered
 *      (api-sketch §7.3: scope is step 3, revocation step 4) — the property
 *      the whole recipient chain was restructured around;
 *   3. the row carries exactly id, albumId and revokedAt, so a later widening
 *      into §10.1's wrapped/kdf columns is a deliberate change, not drift;
 *   4. UQ_recipients_token_hash makes the lookup unambiguous, asserted by
 *      watching a duplicate insert fail rather than by trusting the schema.
 *
 * There is no create path to test: §7.7's route is PR 2's and unbuilt, so
 * rows are inserted here with SQL, as the port's comment says.
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
		[id, OWNER_EMAIL, 'Álbum de prueba', bytes(0x42, 48), bytes(0x43, 24)],
	)
}

/** A QR recipient: the six passphrase columns stay NULL (§6.2, CK constraint). */
async function insertRecipient({ id, token, albumId }, revokedAt = null) {
	await pool.query(
		`INSERT INTO recipients (id, album_id, kind, label, token_hash, revoked_at)
		 VALUES ($1, $2, 'qr', $3, $4, $5)`,
		[id, albumId, 'Abuela', tokenHash(token), revokedAt],
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
