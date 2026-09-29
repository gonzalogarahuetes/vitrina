import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'

import { buildComposition } from '../packages/server/dist/composition-root.js'
import { buildServer } from '../packages/server/dist/adapters/driving/http/server.js'
import { createObjectStore } from '../packages/server/dist/adapters/driven/s3/object-store.js'

/*
 * Phase 0's end-to-end check — plan §7 C.10. One owner signs up, creates an
 * album, creates a media row, uploads both objects, and sees the album listed
 * with the envelope it posted, against the real graph: real Postgres, real
 * SeaweedFS, a real socket.
 *
 * Distinct from every other file here. Those assert one adapter against its
 * port; this one asserts that the composition root wires them into something
 * that answers, and it is the only test where a mistake in `index.ts`'s wiring
 * has anywhere to show.
 *
 * A REAL SOCKET, not `app.inject()`. Inject is faster and the hermetic suite
 * uses it, but it bypasses the HTTP framing — and the two bugs PR 3 actually
 * had, the content-type parser scope and `Content-Length` handling, both live
 * in exactly that layer. A smoke check that cannot see them is decorative.
 *
 * WHAT THIS DOES NOT ASSERT: that any of these bytes are a valid envelope.
 * They are random. The relay never parses the format (§9.1), so a harness that
 * built real envelopes would be testing the crate, not the relay — and it
 * would need `AlbumKey::generate()`, which Phase 0 has not reached.
 *
 * Run `pnpm test` first — it compiles packages/server, which this imports
 * from dist/.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:8333'
const BUCKET = process.env.S3_BUCKET ?? 'vitrina-media'
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
const CLIENT_ORIGIN = 'http://localhost:5173'

/** Credentials come from s3-config.json so there is one source of truth. */
function credentialsFromS3Config() {
	if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
		return {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		}
	}
	const path = fileURLToPath(new URL('../s3-config.json', import.meta.url))
	const config = JSON.parse(readFileSync(path, 'utf8'))
	const identity = config.identities?.find((i) => i.actions?.includes('Write'))
	if (!identity) throw new Error(`no identity with Write in ${path}`)
	const { accessKey, secretKey } = identity.credentials[0]
	return { accessKeyId: accessKey, secretAccessKey: secretKey }
}

const storage = { endpoint: ENDPOINT, region: REGION, bucket: BUCKET, ...credentialsFromS3Config() }

/** Every fixed-width field is `n` random bytes; the schema counts CHARACTERS. */
const b64 = (bytes) => randomBytes(bytes).toString('base64url')

const OWNER_EMAIL = `smoke-${randomUUID()}@x.es`
const ALBUM_ID = randomUUID()
const MEDIA_ID = randomUUID()
const ALBUM_TITLE = 'Álbum de prueba'

/** The wrapping the client posts and the list must give back byte for byte. */
const WRAPPED_KEY = b64(48)
const WRAP_NONCE = b64(24)
/** §9.6's envelope, 128 bytes: inside decode's 81..4096, and not a real one. */
const METADATA = b64(128)

const ASSET = randomBytes(4096)
const THUMBNAIL = randomBytes(512)

let app
let pool
let base
let token
let objectStore
let s3

before(async () => {
	pool = new Pool({ connectionString: DATABASE_URL })
	s3 = new S3Client({
		endpoint: ENDPOINT,
		region: REGION,
		credentials: credentialsFromS3Config(),
		forcePathStyle: true,
	})
	objectStore = createObjectStore(s3, BUCKET)

	try {
		await pool.query('SELECT 1')
		await objectStore.head(`media/${randomUUID()}/asset`)
	} catch (cause) {
		throw new Error(
			`cannot reach Postgres at ${DATABASE_URL} or the bucket "${BUCKET}" at ` +
				`${ENDPOINT}. Start the stack with \`pnpm infra:up && pnpm infra:wait\`. ` +
				'SeaweedFS has NO healthcheck, so `up` returns before it can serve.',
			{ cause },
		)
	}

	/*
	 * The real composition root, not a hand-wired graph — the point of the
	 * file. A missing use case in `buildUseCases` fails here and nowhere else.
	 */
	const { useCases } = buildComposition({
		serverSecret: randomBytes(32),
		databaseUrl: DATABASE_URL,
		storage,
	})
	// `error` rather than false: a 500 here is the failure this file exists to
	// catch, and the envelope's `INTERNAL` says nothing about what threw.
	app = await buildServer({
		config: { clientOrigin: CLIENT_ORIGIN },
		useCases,
		logger: { level: 'error' },
	})

	// Port 0: the OS picks, so two runs never collide and CI needs no port.
	await app.listen({ host: '127.0.0.1', port: 0 })
	base = `http://127.0.0.1:${app.server.address().port}/v1`
})

after(async () => {
	if (app) await app.close()
	if (pool) {
		await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
		await pool.end()
	}
	for (const variant of ['asset', 'thumbnail']) {
		await s3
			?.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `media/${MEDIA_ID}/${variant}` }))
			.catch(() => {})
	}
	s3?.destroy()
})

/** One helper, so every step below is the request and the assertion alone. */
async function call(method, path, { body, contentType = 'application/json', auth = true } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { 'content-type': contentType }),
			...(auth && token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
	})
	const text = await response.text()
	return {
		status: response.status,
		headers: response.headers,
		body: text ? JSON.parse(text) : null,
		text,
	}
}

test('1. signup returns a session token', async () => {
	const response = await call('POST', '/signup', {
		auth: false,
		body: {
			email: OWNER_EMAIL,
			proof: b64(32),
			kdf_salt: b64(16),
			kdf_memory_kib: 65536,
			kdf_iterations: 3,
			kdf_parallelism: 1,
			wrapped_master: b64(48),
			wrap_nonce: b64(24),
		},
	})

	assert.equal(response.status, 201, response.text)
	assert.match(response.body.token, /^[A-Za-z0-9_-]{43}$/)
	token = response.body.token
})

test('2. an album is created and its wrapping round-trips through the list', async () => {
	const created = await call('POST', '/albums', {
		body: { id: ALBUM_ID, title: ALBUM_TITLE, wrapped_key: WRAPPED_KEY, wrap_nonce: WRAP_NONCE },
	})
	assert.equal(created.status, 201, created.text)

	const listed = await call('GET', '/albums')
	assert.equal(listed.status, 200, listed.text)

	const album = listed.body.albums.find((a) => a.id === ALBUM_ID)
	assert.ok(album, 'the album just created is not in the list')
	assert.equal(album.title, ALBUM_TITLE)
	// Byte for byte: a re-encoding somewhere in the stack makes the key
	// unusable and every other assertion here still passes.
	assert.equal(album.wrapped_key, WRAPPED_KEY)
	assert.equal(album.wrap_nonce, WRAP_NONCE)
	assert.equal(album.media_count, 0)
})

test('3. a media row is created pending', async () => {
	const response = await call('POST', `/albums/${ALBUM_ID}/media`, {
		body: { id: MEDIA_ID, kind: 'photo', metadata: METADATA },
	})

	assert.equal(response.status, 201, response.text)
	assert.equal(response.body.status, 'pending')
})

test('4. the first object leaves the row processing, not ready', async () => {
	const response = await call('PUT', `/media/${MEDIA_ID}/asset`, {
		body: ASSET,
		contentType: 'application/octet-stream',
	})

	assert.equal(response.status, 200, response.text)
	assert.equal(response.body.status, 'processing', '§9.7: ready needs BOTH objects')
	assert.equal(response.body.byte_size, null)
})

test('5. the second object reaches ready, with the server-counted size', async () => {
	const response = await call('PUT', `/media/${MEDIA_ID}/thumbnail`, {
		body: THUMBNAIL,
		contentType: 'application/octet-stream',
	})

	assert.equal(response.status, 200, response.text)
	assert.equal(response.body.status, 'ready', response.text)
	// The sum of the two confirming HEADs. A `Content-Length` echoed back
	// gives the same number here, which is why step 6 asserts the store.
	assert.equal(response.body.byte_size, ASSET.length + THUMBNAIL.length)
})

test('6. both objects are in the store, at their opaque keys', async () => {
	const asset = await objectStore.head(`media/${MEDIA_ID}/asset`)
	const thumbnail = await objectStore.head(`media/${MEDIA_ID}/thumbnail`)

	assert.ok(asset, 'the asset is not in the bucket')
	assert.equal(asset.length, ASSET.length)
	assert.ok(thumbnail, 'the thumbnail is not in the bucket')
	assert.equal(thumbnail.length, THUMBNAIL.length)
})

test('7. the album now lists the media, ready', async () => {
	const response = await call('GET', `/albums/${ALBUM_ID}`)

	assert.equal(response.status, 200, response.text)
	assert.equal(response.body.media.length, 1)
	assert.equal(response.body.media[0].id, MEDIA_ID)
	assert.equal(response.body.media[0].status, 'ready')
	/*
	 * §9.4 is the shared route, so no wrapping — but this passes because the
	 * response schema strips it, not because the use case withholds it. It is
	 * the schema that keeps §7.1's no-branch rule holdable; asserted as such.
	 */
	assert.equal(response.body.wrapped_key, undefined)
})

test('8. the envelope comes back exactly as posted', async () => {
	const response = await call('GET', `/albums/${ALBUM_ID}/metadata`)

	assert.equal(response.status, 200, response.text)
	assert.deepEqual(response.body.metadata, [{ media_id: MEDIA_ID, envelope: METADATA }])
	// Ciphertext, so §8.3's header applies — a cached envelope on a shared
	// machine outlives the revocation that was supposed to end access.
	assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('9. a second upload after ready is refused', async () => {
	// The whole point of the ladder: re-upload is fine until the row is
	// ready, and "PUT is idempotent" is the instinct that removes this.
	const response = await call('PUT', `/media/${MEDIA_ID}/asset`, {
		body: ASSET,
		contentType: 'application/octet-stream',
	})

	assert.equal(response.status, 409, response.text)
	assert.equal(response.body.code, 'CONFLICT')
})

test('10. the media count followed the row', async () => {
	const response = await call('GET', '/albums')
	const album = response.body.albums.find((a) => a.id === ALBUM_ID)

	assert.equal(album.media_count, 1)
})

test('11. none of this works without the token', async () => {
	// Asserted last and over the same album, so it cannot pass because the
	// album is missing: every route above is reachable and still refuses.
	for (const [method, path] of [
		['GET', '/albums'],
		['GET', `/albums/${ALBUM_ID}`],
		['GET', `/albums/${ALBUM_ID}/metadata`],
		['GET', `/media/${MEDIA_ID}`],
	]) {
		const response = await call(method, path, { auth: false })
		assert.equal(response.status, 401, `${method} ${path}: ${response.text}`)
	}
})
