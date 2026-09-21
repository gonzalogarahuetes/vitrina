import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { createOwnerRepository } from '../packages/server/dist/adapters/driven/postgres/owner-repository.js'

/*
 * The Postgres OwnerRepository, against the live compose database.
 *
 * Belongs here and not in the hermetic suite: it needs Postgres, and
 * `pnpm test` stays Docker-free (ci.yml, job 1). Run `pnpm test` first — it
 * compiles packages/server, which this imports from dist/.
 *
 * Expected export:  createOwnerRepository(pool: Pool): OwnerRepository
 *
 * Four properties the port promises and only a real database can show:
 *   1. every column round-trips, bytea included, byte for byte;
 *   2. signup's two writes are ONE transaction (api-sketch §7.5) — the row
 *      §6.2 owes, and the one no fake can prove;
 *   3. a duplicate address is the UNIQUE, raised as DUPLICATE_ADDRESS, with
 *      the submitted address nowhere in the error (#15);
 *   4. the `kind = 'password'` predicate holds once a recovery row exists.
 *
 * Isolation is by unique address per test rather than by truncating, so a
 * failed run leaves the developer's database usable. Everything created is
 * deleted in `after`; owner_keys and owner_tokens cascade.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const pool = new Pool({ connectionString: DATABASE_URL })
const repository = createOwnerRepository(pool)

/** Every address this file creates, for the cleanup below. */
const created = []
const address = (tag) => {
	const email = `${tag}-${randomUUID()}@x.es`
	created.push(email)
	return email
}

const bytes = (fill, length) => Buffer.alloc(length, fill)
const hex = (b) => Buffer.from(b).toString('hex')

/** A well-formed body, with every binary field a distinct recognisable value. */
const passwordKey = () => ({
	kdfSalt: bytes(0x41, 16),
	params: { memoryKib: 65536, iterations: 3, parallelism: 1 },
	wrappedMaster: bytes(0x42, 48),
	wrapNonce: bytes(0x43, 24),
})

const newOwner = (email) => ({
	email,
	authHash: createHash('sha256').update(email).digest(),
	passwordKey: passwordKey(),
})

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

after(async () => {
	if (created.length > 0) {
		await pool.query('DELETE FROM owners WHERE email = ANY($1)', [created])
	}
	await pool.end()
})

test('a created owner round-trips through every read', async () => {
	const email = address('roundtrip')
	const owner = newOwner(email)

	const { id, createdAt } = await repository.createWithPasswordKey(owner)
	assert.match(id, /^[0-9a-f-]{36}$/)
	assert.ok(createdAt instanceof Date, 'created_at should arrive as a Date')

	const credential = await repository.findCredentialByEmail(email)
	assert.equal(credential.id, id)
	assert.equal(hex(credential.authHash), hex(owner.authHash))

	const kdf = await repository.findKdfByEmail(email)
	assert.equal(hex(kdf.kdfSalt), hex(owner.passwordKey.kdfSalt))
	assert.deepEqual(kdf.params, owner.passwordKey.params)

	const key = await repository.findPasswordKeyByOwnerId(id)
	assert.equal(hex(key.kdfSalt), hex(owner.passwordKey.kdfSalt))
	assert.equal(hex(key.wrappedMaster), hex(owner.passwordKey.wrappedMaster))
	assert.equal(hex(key.wrapNonce), hex(owner.passwordKey.wrapNonce))
	assert.deepEqual(key.params, owner.passwordKey.params)
})

test('bytea survives bytes that are not printable', async () => {
	// 0x00 and 0xff both round-trip, and the length is preserved. A parameter
	// serialised as JSON rather than as bytea fails here (pg does that to a
	// plain Uint8Array), as does a value that lost a trailing NUL.
	const email = address('bytes')
	const owner = {
		...newOwner(email),
		passwordKey: {
			...passwordKey(),
			kdfSalt: Buffer.from([0x00, 0xff, 0x00, 0xff, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xfe, 0x00]),
		},
	}

	const { id } = await repository.createWithPasswordKey(owner)
	const key = await repository.findPasswordKeyByOwnerId(id)

	assert.equal(key.kdfSalt.length, 16)
	assert.equal(hex(key.kdfSalt), hex(owner.passwordKey.kdfSalt))
})

test('an unknown address reads as null, not as an error', async () => {
	// /login/params and /login both depend on this: a miss is a value they
	// substitute for, never an exception (§4.3).
	assert.equal(await repository.findCredentialByEmail('nobody-' + randomUUID() + '@x.es'), null)
	assert.equal(await repository.findKdfByEmail('nobody-' + randomUUID() + '@x.es'), null)
	assert.equal(await repository.findPasswordKeyByOwnerId(randomUUID()), null)
})

test('the two writes are one transaction: a failed key row rolls the owner back', async () => {
	// §6.2's owed row, and the property no fake can demonstrate. The second
	// insert is failed by a real constraint — wrapped_master must be 48 bytes
	// (CHK_owner_keys_wrapped_master_len) — rather than by a stub, so this
	// exercises the rollback the database actually performs.
	const email = address('rollback')
	const doomed = {
		...newOwner(email),
		passwordKey: { ...passwordKey(), wrappedMaster: bytes(0x42, 47) },
	}

	await assert.rejects(
		() => repository.createWithPasswordKey(doomed),
		(error) => {
			// A CHECK violation is not a taken address. A catch that reports every
			// failure as DUPLICATE_ADDRESS passes the rollback assertion below and
			// still tells the client the wrong thing; only 23505 is a duplicate,
			// and anything else belongs on the INTERNAL path with its stack.
			assert.notEqual(error.code, 'DUPLICATE_ADDRESS')
			return true
		},
	)

	const { rows } = await pool.query('SELECT count(*)::int AS n FROM owners WHERE email = $1', [email])
	assert.equal(rows[0].n, 0, 'the owners row survived a failed owner_keys insert')
})

test('a duplicate address is DUPLICATE_ADDRESS, and the error names no address', async () => {
	const email = address('duplicate')
	await repository.createWithPasswordKey(newOwner(email))

	await assert.rejects(
		() => repository.createWithPasswordKey(newOwner(email)),
		(error) => {
			assert.equal(error.code, 'DUPLICATE_ADDRESS')
			// #15, and the specific leak error-envelope.ts measured: pg puts the
			// submitted value in `detail`, and errWithCause copies a cause's own
			// enumerable properties into the log line. Chaining the pg error
			// verbatim fails here; chaining a message you wrote does not.
			for (const string of stringsIn(error)) {
				assert.ok(!string.includes(email), `the address reached the error: ${string}`)
			}
			return true
		},
	)

	// And exactly one row exists, so the failure was the UNIQUE rather than a
	// check-then-insert that raced and wrote twice.
	const { rows } = await pool.query('SELECT count(*)::int AS n FROM owners WHERE email = $1', [email])
	assert.equal(rows[0].n, 1)
})

test("the reads select kind = 'password', once a recovery row exists", async () => {
	// Phase 2 inserts a second owner_keys row. A `SELECT … LIMIT 1` without the
	// kind predicate works until that day and then returns the wrong salt —
	// which is why UQ_owner_keys_one_password exists. Inserted here directly,
	// because the port has no method that writes one.
	const email = address('recovery')
	const owner = newOwner(email)
	const { id } = await repository.createWithPasswordKey(owner)

	await pool.query(
		`INSERT INTO owner_keys (owner_id, kind, wrapped_master, wrap_nonce)
		 VALUES ($1, 'recovery', $2, $3)`,
		[id, bytes(0x99, 48), bytes(0x98, 24)],
	)

	const kdf = await repository.findKdfByEmail(email)
	assert.equal(hex(kdf.kdfSalt), hex(owner.passwordKey.kdfSalt))

	const key = await repository.findPasswordKeyByOwnerId(id)
	assert.equal(hex(key.wrappedMaster), hex(owner.passwordKey.wrappedMaster))
})

test('a session token round-trips by hash', async () => {
	const email = address('token')
	const { id } = await repository.createWithPasswordKey(newOwner(email))

	const tokenHash = createHash('sha256').update(randomUUID()).digest()
	const expiresAt = new Date('2026-10-04T12:34:56.000Z')
	await repository.insertToken({ ownerId: id, tokenHash, expiresAt })

	const row = await repository.findTokenByHash(tokenHash)
	assert.equal(row.ownerId, id)
	assert.equal(row.expiresAt.toISOString(), expiresAt.toISOString())
	assert.equal(row.revokedAt, null, 'a fresh token is not revoked')
})

test('an unknown token hash reads as null', async () => {
	const absent = createHash('sha256').update(randomUUID()).digest()
	assert.equal(await repository.findTokenByHash(absent), null)
})

test('a revoked token is returned, not filtered out', async () => {
	// §7.3 steps 1–2 decide 401, not the query. A repository that filtered
	// revoked rows would make a revoked token indistinguishable from an
	// unknown one, which is a different code path in the auth ladder.
	const email = address('revoked')
	const { id } = await repository.createWithPasswordKey(newOwner(email))

	const tokenHash = createHash('sha256').update(randomUUID()).digest()
	await repository.insertToken({
		ownerId: id,
		tokenHash,
		expiresAt: new Date('2026-10-04T12:34:56.000Z'),
	})
	await pool.query('UPDATE owner_tokens SET revoked_at = now() WHERE token_hash = $1', [tokenHash])

	const row = await repository.findTokenByHash(tokenHash)
	assert.ok(row, 'a revoked token must still be found')
	assert.ok(row.revokedAt instanceof Date)
})

test('an expired token is returned, not filtered out', async () => {
	// Same rule, the other half: expiry is step 2's decision, not the query's.
	const email = address('expired')
	const { id } = await repository.createWithPasswordKey(newOwner(email))

	const tokenHash = createHash('sha256').update(randomUUID()).digest()
	const expiresAt = new Date('2020-01-01T00:00:00.000Z')
	await repository.insertToken({ ownerId: id, tokenHash, expiresAt })

	const row = await repository.findTokenByHash(tokenHash)
	assert.ok(row, 'an expired token must still be found')
	assert.equal(row.expiresAt.toISOString(), expiresAt.toISOString())
})

before(async () => {
	// Fail early and clearly if the stack is not up, rather than as ten
	// identical connection errors.
	try {
		await pool.query('SELECT 1')
	} catch (cause) {
		throw new Error('Postgres is not reachable — run `pnpm infra:up` first', { cause })
	}
})
