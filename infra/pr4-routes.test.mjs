import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

import { buildComposition } from '../packages/server/dist/composition-root.js'
import { buildServer } from '../packages/server/dist/adapters/driving/http/server.js'

/*
 * PR 4's route end to end — api-sketch §10.1, §10.3 — over the real
 * composition root, real Postgres, a real socket and the real envelope
 * crate. Steps run in order and share state, as pr2-routes.test.mjs's do.
 *
 * The done-when, and the first time the passphrase path runs whole: a
 * recipient created through the API with a wrapping the crate produced,
 * the wrapping fetched back through §10.1, unwrapped with the passphrase
 * from the RESPONSE'S fields alone, and the K_album that comes out opens a
 * title the relay served through §9.4. AlbumKey has no byte getter (encryption
 * spec §2.2), so the key is proven by what it decrypts, not by comparison.
 *
 * The crypto here is the client's, done by the crate's WASM binding. The
 * relay never sees the passphrase, the KEK or K_album — this file holds all
 * three, which is the point: it plays the client.
 *
 * Needs Postgres and the WASM build — `pnpm --filter @vitrina/envelope
 * build:wasm`, which needs the wasm32 toolchain. Run `pnpm test` first; it
 * compiles packages/server, which this imports from dist/.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'

const WASM_DIR = new URL('../packages/envelope/wasm/', import.meta.url)

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const unb64 = (s) => Buffer.from(s, 'base64url')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest()
/** A uuid as the 16 raw bytes every AAD carries (encryption spec §6.2). */
const idBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex')

const OWNER_EMAIL = `pr4-${randomUUID()}@x.es`
const ALBUM_ID = randomUUID()
const TITLE = 'Verano 2026 · la playa'
const PASSPHRASE = 'tortilla de patatas con cebolla'

/**
 * Above 002's floors and NOT WrapParams.v1(). A client that ignored the
 * response and used the constant would fail step 5 — encryption spec §9
 * category 9's bug, caught at the API. Kept small so Argon2id is quick in CI.
 */
const PARAMS = { memoryKib: 20480, iterations: 5, parallelism: 3 }

let envelope
let app
let pool
let base
let ownerToken
let albumKey
const passphrase = { id: randomUUID(), token: randomBytes(32) }
const qr = { id: randomUUID(), token: randomBytes(32) }
/** What step 2 posted, for step 4 to compare the response against. */
let posted
/** Step 4's response body — step 5 unwraps from this and nothing else. */
let fetched

before(async () => {
	try {
		const { default: init, ...exports } = await import(new URL('envelope.js', WASM_DIR))
		await init({ module_or_path: await readFile(new URL('envelope_bg.wasm', WASM_DIR)) })
		envelope = exports
	} catch (cause) {
		throw new Error(
			'cannot load the envelope WASM build from packages/envelope/wasm/. Build it with ' +
				'`pnpm --filter @vitrina/envelope build:wasm` (needs the wasm32 target and ' +
				'wasm-bindgen-cli). This test plays the client; without the crate it has ' +
				'nothing to unwrap with.',
			{ cause },
		)
	}

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
		// albums, recipients and access_log cascade.
		await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
		await pool.end()
	}
})

async function call(method, path, { body, token } = {}) {
	const headers = {}
	if (token) headers.authorization = `Bearer ${b64(token)}`
	if (body !== undefined) headers['content-type'] = 'application/json'

	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	return {
		status: response.status,
		headers: response.headers,
		body: text ? JSON.parse(text) : null,
		text,
	}
}

/** Bare envelope, no `details` — every §10.1 error. */
function assertBareError(response, status, code) {
	assert.equal(response.status, status, response.text)
	assert.deepEqual(Object.keys(response.body).sort(), ['code', 'message'])
	assert.equal(response.body.code, code)
}

test('1. an owner signs up and creates an album whose title is real ciphertext', async () => {
	const signup = await call('POST', '/signup', {
		body: {
			email: OWNER_EMAIL,
			proof: b64(randomBytes(32)),
			kdf_salt: b64(randomBytes(16)),
			kdf_memory_kib: 65536,
			kdf_iterations: 3,
			kdf_parallelism: 1,
			wrapped_master: b64(randomBytes(48)),
			wrap_nonce: b64(randomBytes(24)),
		},
	})
	assert.equal(signup.status, 201, signup.text)
	ownerToken = unb64(signup.body.token)

	albumKey = envelope.AlbumKey.fromBytes(randomBytes(32))

	// The owner's own wrapping of K_album is random bytes: the owner path is
	// not what this file tests, and §9.2's relay never inspects it.
	const album = await call('POST', '/albums', {
		token: ownerToken,
		body: {
			id: ALBUM_ID,
			title: b64(envelope.encryptAlbumTitle(albumKey, idBytes(ALBUM_ID), TITLE)),
			wrapped_key: b64(randomBytes(48)),
			wrap_nonce: b64(randomBytes(24)),
		},
	})
	assert.equal(album.status, 201, album.text)
})

test('2. a passphrase recipient and a QR recipient are created through the API', async () => {
	// The crate wraps; the id is client-generated because it is in the AAD.
	const wrapping = envelope.wrapAlbumKey(
		albumKey,
		PASSPHRASE,
		new envelope.WrapParams(PARAMS.memoryKib, PARAMS.iterations, PARAMS.parallelism),
		idBytes(passphrase.id),
	)
	posted = {
		id: passphrase.id,
		kind: 'passphrase',
		label: b64(envelope.encryptRecipientLabel(albumKey, idBytes(passphrase.id), 'María')),
		token_hash: b64(sha256(passphrase.token)),
		wrapped: b64(wrapping.wrapped),
		wrap_nonce: b64(wrapping.wrapNonce),
		kdf_salt: b64(wrapping.kdfSalt),
		kdf_memory_kib: PARAMS.memoryKib,
		kdf_iterations: PARAMS.iterations,
		kdf_parallelism: PARAMS.parallelism,
	}

	const created = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		token: ownerToken,
		body: posted,
	})
	assert.equal(created.status, 201, created.text)

	const qrCreated = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		token: ownerToken,
		body: {
			id: qr.id,
			kind: 'qr',
			label: b64(envelope.encryptRecipientLabel(albumKey, idBytes(qr.id), 'Abuelo')),
			token_hash: b64(sha256(qr.token)),
		},
	})
	assert.equal(qrCreated.status, 201, qrCreated.text)
})

test('3. the owner cannot fetch a recipient key — 401, no fallback (§7.1)', async () => {
	assertBareError(await call('GET', '/recipient/key', { token: ownerToken }), 401, 'UNAUTHENTICATED')
})

test('4. the passphrase recipient fetches its wrapping: 200, no-store, every field as posted', async () => {
	const response = await call('GET', '/recipient/key', { token: passphrase.token })

	assert.equal(response.status, 200, response.text)
	assert.equal(response.headers.get('cache-control'), 'no-store')
	assert.deepEqual(response.body, {
		id: posted.id,
		kdf_salt: posted.kdf_salt,
		kdf_memory_kib: posted.kdf_memory_kib,
		kdf_iterations: posted.kdf_iterations,
		kdf_parallelism: posted.kdf_parallelism,
		wrapped: posted.wrapped,
		wrap_nonce: posted.wrap_nonce,
	})
	fetched = response.body
})

test('5. the passphrase unwraps K_album, and it opens the title the relay serves', async () => {
	/*
	 * The done-when. Every input to the unwrap comes from step 4's RESPONSE —
	 * the id, the salt, the three integers, the wrapping, the nonce — and the
	 * passphrase from the person. Nothing is taken from what the test posted,
	 * so a route that returned the wrong row, or a mangled field, fails here.
	 */
	const recovered = envelope.unwrapAlbumKey(
		PASSPHRASE,
		new envelope.WrapParams(fetched.kdf_memory_kib, fetched.kdf_iterations, fetched.kdf_parallelism),
		idBytes(fetched.id),
		envelope.WrappedKey.fromParts(unb64(fetched.wrapped), unb64(fetched.wrap_nonce), unb64(fetched.kdf_salt)),
	)

	// §10.3 step 5: then as any recipient.
	const details = await call('GET', `/albums/${ALBUM_ID}`, { token: passphrase.token })
	assert.equal(details.status, 200, details.text)

	assert.equal(envelope.decryptAlbumTitle(recovered, idBytes(ALBUM_ID), unb64(details.body.title)), TITLE)
})

test('6. every input to the unwrap is load-bearing', async () => {
	/*
	 * Each failure is the opaque AEAD error a client renders as "wrong
	 * passphrase" (§10.3) — the relay cannot tell, and does not. The second
	 * case is why the response carries the row's parameters; the third is why
	 * it carries `id` (invite spec §4: the payload does not).
	 */
	const wrapped = () =>
		envelope.WrappedKey.fromParts(unb64(fetched.wrapped), unb64(fetched.wrap_nonce), unb64(fetched.kdf_salt))
	const rowParams = () =>
		new envelope.WrapParams(fetched.kdf_memory_kib, fetched.kdf_iterations, fetched.kdf_parallelism)

	const cases = [
		['the wrong passphrase', () => envelope.unwrapAlbumKey('tortilla sin cebolla', rowParams(), idBytes(fetched.id), wrapped())],
		['WrapParams.v1() instead of the row', () => envelope.unwrapAlbumKey(PASSPHRASE, envelope.WrapParams.v1(), idBytes(fetched.id), wrapped())],
		['another recipient id in the AAD', () => envelope.unwrapAlbumKey(PASSPHRASE, rowParams(), idBytes(qr.id), wrapped())],
	]
	for (const [name, unwrap] of cases) {
		assert.throws(unwrap, (e) => e.name === 'EnvelopeError' && e.code === 'AuthenticationFailed', name)
	}
})

test('7. the QR recipient gets 404 — no key material, so no resource', async () => {
	assertBareError(await call('GET', '/recipient/key', { token: qr.token }), 404, 'NOT_FOUND')
})

test('8. once revoked, the passphrase recipient gets 403 and no wrapping', async () => {
	const revoked = await call('POST', `/recipients/${passphrase.id}/revoke`, { token: ownerToken })
	assert.equal(revoked.status, 200, revoked.text)

	const response = await call('GET', '/recipient/key', { token: passphrase.token })

	assertBareError(response, 403, 'ACCESS_REVOKED')
	for (const field of ['wrapped', 'wrap_nonce', 'kdf_salt']) {
		assert.ok(!response.text.includes(posted[field]), `${field} reached a 403`)
	}
})
