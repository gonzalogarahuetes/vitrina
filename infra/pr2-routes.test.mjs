import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { Pool } from 'pg'

import { buildComposition } from '../packages/server/dist/composition-root.js'
import { buildServer } from '../packages/server/dist/adapters/driving/http/server.js'

/*
 * PR 2's four late routes end to end — api-sketch §7.5, §7.7, §7.8 — over the
 * real composition root, real Postgres and a real socket. Steps run in order
 * and share state, as smoke.test.mjs's do.
 *
 * The done-when for this work: a recipient created and revoked through the
 * API, not by direct insert, and then used as a credential. Until these
 * routes existed nothing could create a recipient except SQL, so §9.4's
 * "identical response shape for both caller kinds" was tested only against
 * rows the tests wrote themselves — and PR 4's key route could not be
 * exercised end to end.
 *
 * What this adds over test/recipient-routes.test.mjs: the real adapters'
 * constraint mapping (23505 on UQ_recipients_token_hash as a bare 409), the
 * real columns, and HTTP framing. The empty-JSON-body 400 is asserted over a
 * socket because it is a parser behaviour, and inject() is not the parser's
 * whole input.
 *
 * Needs Postgres only — no object is uploaded. Run `pnpm test` first; it
 * compiles packages/server, which this imports from dist/.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const b64 = (bytes) => randomBytes(bytes).toString('base64url')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest()

const OWNER_EMAIL = `pr2-${randomUUID()}@x.es`
const PROOF = b64(32)
const ALBUM_ID = randomUUID()

/** The invite's token, which the client keeps; the relay only ever sees its hash. */
const RECIPIENT_TOKEN = randomBytes(32)
const RECIPIENT = {
	id: randomUUID(),
	kind: 'passphrase',
	label: b64(60),
	token_hash: sha256(RECIPIENT_TOKEN).toString('base64url'),
	wrapped: b64(48),
	wrap_nonce: b64(24),
	kdf_salt: b64(16),
	kdf_memory_kib: 65536,
	kdf_iterations: 3,
	kdf_parallelism: 1,
}

let app
let pool
let base
/** Two sessions for one owner: a laptop and a phone. */
const sessions = {}
let revokedAt

before(async () => {
	pool = new Pool({ connectionString: DATABASE_URL })
	try {
		await pool.query('SELECT 1')
	} catch (cause) {
		throw new Error(
			`cannot reach Postgres at ${DATABASE_URL}. Start the stack with ` +
				'`pnpm infra:up && pnpm infra:wait`.',
			{ cause },
		)
	}

	// Storage config is required by the composition root and never used here.
	const { useCases } = buildComposition({
		serverSecret: randomBytes(32),
		databaseUrl: DATABASE_URL,
		storage: {
			endpoint: 'http://127.0.0.1:1',
			region: 'us-east-1',
			bucket: 'unused',
			accessKeyId: 'unused',
			secretAccessKey: 'unused',
		},
	})
	app = await buildServer({
		config: { clientOrigin: 'http://localhost:5173' },
		useCases,
		logger: { level: 'error' },
	})
	await app.listen({ host: '127.0.0.1', port: 0 })
	base = `http://127.0.0.1:${app.server.address().port}/v1`
})

after(async () => {
	if (app) await app.close()
	if (pool) {
		// albums, recipients, owner_tokens and access_log all cascade.
		await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
		await pool.end()
	}
})

/**
 * No body means no Content-Type, which is §7.5 and §7.8's wire contract.
 * `contentType` lets one step break it deliberately.
 */
async function call(method, path, { body, token, contentType } = {}) {
	const headers = {}
	if (token) headers.authorization = `Bearer ${token}`
	if (body !== undefined) headers['content-type'] = 'application/json'
	if (contentType) headers['content-type'] = contentType

	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	return { status: response.status, body: text ? JSON.parse(text) : null, text }
}

test('1. an owner signs up and signs in on a second device', async () => {
	const signup = await call('POST', '/signup', {
		body: {
			email: OWNER_EMAIL,
			proof: PROOF,
			kdf_salt: b64(16),
			kdf_memory_kib: 65536,
			kdf_iterations: 3,
			kdf_parallelism: 1,
			wrapped_master: b64(48),
			wrap_nonce: b64(24),
		},
	})
	assert.equal(signup.status, 201, signup.text)
	sessions.laptop = signup.body.token

	const login = await call('POST', '/login', { body: { email: OWNER_EMAIL, proof: PROOF } })
	assert.equal(login.status, 200, login.text)
	sessions.phone = login.body.token

	const album = await call('POST', '/albums', {
		token: sessions.laptop,
		body: { id: ALBUM_ID, title: b64(60), wrapped_key: b64(48), wrap_nonce: b64(24) },
	})
	assert.equal(album.status, 201, album.text)
})

test('2. a passphrase recipient is created through the API, every column as posted', async () => {
	const response = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		token: sessions.laptop,
		body: RECIPIENT,
	})
	assert.equal(response.status, 201, response.text)
	assert.equal(response.body.id, RECIPIENT.id)

	// Read the table, not the API: a wrapping re-encoded anywhere in the stack
	// is a passphrase that never unwraps, and every response would still look fine.
	const { rows: [row] } = await pool.query('SELECT * FROM recipients WHERE id = $1', [RECIPIENT.id])
	assert.equal(row.album_id, ALBUM_ID)
	assert.equal(row.kind, 'passphrase')
	for (const [column, field] of [
		['label', 'label'],
		['token_hash', 'token_hash'],
		['wrapped', 'wrapped'],
		['wrap_nonce', 'wrap_nonce'],
		['kdf_salt', 'kdf_salt'],
	]) {
		assert.equal(row[column].toString('base64url'), RECIPIENT[field], `${column} changed in transit`)
	}
	assert.equal(row.kdf_memory_kib, 65536)
	assert.equal(row.kdf_iterations, 3)
	assert.equal(row.kdf_parallelism, 1)
	assert.equal(row.revoked_at, null)
})

test('3. a second recipient with the same token_hash is a bare 409 from the real constraint', async () => {
	// The case that answered 500 before the adapter matched UQ_recipients_token_hash.
	const response = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		token: sessions.laptop,
		body: { ...RECIPIENT, id: randomUUID() },
	})
	assert.equal(response.status, 409, response.text)
	assert.deepEqual(response.body, { code: 'CONFLICT', message: response.body.message })
})

test('4. the created recipient reads its album, with the owner\'s exact body (§9.4)', async () => {
	const asRecipient = await call('GET', `/albums/${ALBUM_ID}`, {
		token: RECIPIENT_TOKEN.toString('base64url'),
	})
	const asOwner = await call('GET', `/albums/${ALBUM_ID}`, { token: sessions.laptop })

	assert.equal(asRecipient.status, 200, asRecipient.text)
	assert.equal(asRecipient.text, asOwner.text)
})

test('5. revoke sets revoked_at, returns the original on a retry, and deletes nothing', async () => {
	// §11.6's album_opened route is PR 5's, so the view history is written by
	// hand; what is under test is that revoke leaves it alone.
	await pool.query(
		`INSERT INTO access_log (recipient_id, event) VALUES ($1, 'album_opened')`,
		[RECIPIENT.id],
	)

	const first = await call('POST', `/recipients/${RECIPIENT.id}/revoke`, { token: sessions.laptop })
	assert.equal(first.status, 200, first.text)
	revokedAt = first.body.revoked_at

	const retry = await call('POST', `/recipients/${RECIPIENT.id}/revoke`, { token: sessions.laptop })
	assert.equal(retry.status, 200, retry.text)
	assert.equal(retry.body.revoked_at, revokedAt, 'a retried revoke moved the timestamp')

	const { rows: [log] } = await pool.query(
		'SELECT count(*)::int AS n FROM access_log WHERE recipient_id = $1',
		[RECIPIENT.id],
	)
	assert.equal(log.n, 1, 'revoke destroyed the view history')
})

test('6. the revoked recipient gets 403 on its own album, from the next request', async () => {
	const response = await call('GET', `/albums/${ALBUM_ID}`, {
		token: RECIPIENT_TOKEN.toString('base64url'),
	})
	assert.equal(response.status, 403, response.text)
	assert.equal(response.body.code, 'ACCESS_REVOKED')
})

test('7. a body-less POST sent as empty JSON is the parser\'s 400, over a real socket', async () => {
	// §7.5's "send no Content-Type". Before auth: no token gives the same 400.
	const response = await call('POST', '/logout', {
		token: sessions.phone,
		contentType: 'application/json',
	})
	assert.equal(response.status, 400, response.text)
	assert.equal(response.body.code, 'VALIDATION_FAILED')

	const still = await call('GET', '/albums', { token: sessions.phone })
	assert.equal(still.status, 200, 'a rejected logout revoked the session anyway')
})

test('8. logout ends the phone and leaves the laptop signed in', async () => {
	const response = await call('POST', '/logout', { token: sessions.phone })
	assert.equal(response.status, 204, response.text)
	assert.equal(response.text, '')

	assert.equal((await call('GET', '/albums', { token: sessions.phone })).status, 401)
	assert.equal((await call('GET', '/albums', { token: sessions.laptop })).status, 200)
})

test('9. logout/all ends every session, the calling one included', async () => {
	const login = await call('POST', '/login', { body: { email: OWNER_EMAIL, proof: PROOF } })
	const tablet = login.body.token

	const response = await call('POST', '/logout/all', { token: sessions.laptop })
	assert.equal(response.status, 204, response.text)

	for (const [name, token] of [['laptop', sessions.laptop], ['tablet', tablet]]) {
		assert.equal((await call('GET', '/albums', { token })).status, 401, `${name} survived`)
	}
	const { rows: [open] } = await pool.query(
		`SELECT count(*)::int AS n FROM owner_tokens t JOIN owners o ON o.id = t.owner_id
		 WHERE o.email = $1 AND t.revoked_at IS NULL`,
		[OWNER_EMAIL],
	)
	assert.equal(open.n, 0)
})
