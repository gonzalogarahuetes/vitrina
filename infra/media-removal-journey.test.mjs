import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

import { buildComposition } from '../packages/server/dist/composition-root.js'
import { buildServer } from '../packages/server/dist/adapters/driving/http/server.js'

// api-sketch §9.11 end to end — the real composition root, Postgres, SeaweedFS
// and a socket. The hermetic suite runs removal against fakes that implement
// the filters; this is the one place a removed photograph is checked against
// the bucket itself and every read path over the real SQL.
//
// The relay is format-blind (§9.1), so the bytes here are arbitrary rather
// than envelopes, and the envelope crate is not needed.

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:8333'
const BUCKET = process.env.S3_BUCKET ?? 'vitrina-media'
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1'

function credentialsFromS3Config() {
	if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
		return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
	}
	const path = fileURLToPath(new URL('../s3-config.json', import.meta.url))
	const identity = JSON.parse(readFileSync(path, 'utf8')).identities?.find((i) => i.actions?.includes('Write'))
	if (!identity) throw new Error(`no identity with Write in ${path}`)
	const { accessKey, secretKey } = identity.credentials[0]
	return { accessKeyId: accessKey, secretAccessKey: secretKey }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const unb64 = (s) => Buffer.from(s, 'base64url')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest()

const OWNER_EMAIL = `removal-${randomUUID()}@x.es`
const ALBUM_ID = randomUUID()
const KEEP = randomUUID()
const GONE = randomUUID()
const LATE = randomUUID()
const RECIPIENT = { id: randomUUID(), token: randomBytes(32) }

let app
let pool
let s3
let base
let ownerToken
/*
 * Set by the step that establishes each precondition. node:test runs every
 * step even after one fails, and steps 3 and 5 pass on an empty log and an
 * unrouted DELETE respectively — measured, the first run did exactly that.
 */
let openRecorded = false
let erased = false

before(async () => {
	pool = new Pool({ connectionString: DATABASE_URL })
	s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: credentialsFromS3Config(), forcePathStyle: true })
	try {
		await pool.query('SELECT 1')
	} catch (cause) {
		throw new Error('cannot reach Postgres — `pnpm infra:up && pnpm infra:wait`.', { cause })
	}

	const { useCases } = buildComposition({
		serverSecret: randomBytes(32),
		databaseUrl: DATABASE_URL,
		storage: { endpoint: ENDPOINT, region: REGION, bucket: BUCKET, ...credentialsFromS3Config() },
	})
	app = await buildServer({ config: { clientOrigin: 'http://localhost:5173' }, useCases, logger: { level: 'error' } })
	await app.listen({ host: '127.0.0.1', port: 0 })
	base = `http://127.0.0.1:${app.server.address().port}/v1`
})

after(async () => {
	if (app) await app.close()
	if (pool) {
		await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
		await pool.end()
	}
	for (const id of [KEEP, GONE, LATE]) {
		for (const variant of ['asset', 'thumbnail']) {
			await s3?.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `media/${id}/${variant}` })).catch(() => {})
		}
	}
	s3?.destroy()
})

async function call(method, path, { body, token, headers = {} } = {}) {
	const sent = { ...headers }
	if (token) sent.authorization = `Bearer ${b64(token)}`
	let payload
	if (Buffer.isBuffer(body)) {
		sent['content-type'] = 'application/octet-stream'
		payload = body
	} else if (body !== undefined) {
		sent['content-type'] = 'application/json'
		payload = JSON.stringify(body)
	}
	const response = await fetch(`${base}${path}`, { method, headers: sent, body: payload })
	const text = await response.text()
	let json = null
	try {
		json = text ? JSON.parse(text) : null
	} catch {
		// a ciphertext body; the tests below that read one only check its status
	}
	return { status: response.status, text, body: json }
}

/** The bucket's own answer, beneath the adapter: 404 is the only "absent". */
async function inBucket(key) {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
		return true
	} catch (error) {
		if (error?.$metadata?.httpStatusCode === 404) return false
		throw error
	}
}

const owner = () => ({ token: ownerToken })
const viewer = () => ({ token: RECIPIENT.token })

async function publish(id) {
	const created = await call('POST', `/albums/${ALBUM_ID}/media`, {
		...owner(),
		body: { id, kind: 'photo', metadata: b64(randomBytes(120)) },
	})
	assert.equal(created.status, 201, created.text)
	assert.equal((await call('PUT', `/media/${id}/asset`, { ...owner(), body: randomBytes(4096) })).status, 200)
	const thumb = await call('PUT', `/media/${id}/thumbnail`, { ...owner(), body: randomBytes(512) })
	assert.equal(thumb.body?.status, 'ready', thumb.text)
}

test('1. the owner publishes two photos and invites a recipient, who opens one', async () => {
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

	const album = await call('POST', '/albums', {
		...owner(),
		body: { id: ALBUM_ID, title: b64(randomBytes(60)), wrapped_key: b64(randomBytes(48)), wrap_nonce: b64(randomBytes(24)) },
	})
	assert.equal(album.status, 201, album.text)

	await publish(KEEP)
	await publish(GONE)

	const invited = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		...owner(),
		body: { id: RECIPIENT.id, kind: 'qr', label: b64(randomBytes(60)), token_hash: b64(sha256(RECIPIENT.token)) },
	})
	assert.equal(invited.status, 201, invited.text)

	const opened = await call('GET', `/media/${GONE}/asset`, { ...viewer(), headers: { range: 'bytes=0-' } })
	assert.equal(opened.status, 206)

	// So that step 3 cannot pass on a log that never had the row.
	const { rows } = await pool.query(
		"SELECT 1 FROM access_log WHERE recipient_id = $1 AND media_id = $2 AND event = 'asset_viewed'",
		[RECIPIENT.id, GONE],
	)
	assert.equal(rows.length, 1)
	openRecorded = true
})

test('2. DELETE answers 204 with no body, and the bucket and the row agree', async () => {
	const removed = await call('DELETE', `/media/${GONE}`, owner())

	assert.equal(removed.status, 204, removed.text)
	assert.equal(removed.text, '')

	// Asked of the store directly: the adapter's head could be wrong in the
	// same way its remove is, and then the two would agree on a falsehood.
	assert.equal(await inBucket(`media/${GONE}/asset`), false, 'the asset is still in the bucket')
	assert.equal(await inBucket(`media/${GONE}/thumbnail`), false, 'the thumbnail is still in the bucket')
	assert.equal(await inBucket(`media/${KEEP}/asset`), true, 'the other photograph went with it')

	const { rows } = await pool.query('SELECT 1 FROM media WHERE id = $1', [GONE])
	assert.equal(rows.length, 0, 'the row survived a 204')
	erased = true
})

test('3. the open recorded against it went with it', async () => {
	assert.ok(openRecorded && erased, 'steps 1 and 2 did not both pass, so an empty log here proves nothing')
	// The journey's one open was of GONE, so no asset_viewed row may remain at
	// all. Filtering on `media_id = GONE` passes under ON DELETE SET NULL —
	// measured: the row survives with a null media_id, a view of nothing.
	const { rows } = await pool.query(
		"SELECT event, media_id FROM access_log WHERE recipient_id = $1 AND event = 'asset_viewed'",
		[RECIPIENT.id],
	)
	assert.deepEqual(rows, [])
})

test('4. every read path omits or refuses it, for both schemes', async () => {
	assert.ok(erased, 'step 2 did not answer 204, so the row was never removed and every read below still serves it')
	for (const who of [owner(), viewer()]) {
		const details = await call('GET', `/albums/${ALBUM_ID}`, who)
		assert.equal(details.status, 200, details.text)
		assert.deepEqual(details.body.media.map((m) => m.id), [KEEP])

		const metadata = await call('GET', `/albums/${ALBUM_ID}/metadata`, who)
		assert.equal(metadata.status, 200, metadata.text)
		assert.deepEqual(metadata.body.metadata.map((m) => m.media_id), [KEEP])

		for (const variant of ['asset', 'thumbnail']) {
			const fetched = await call('GET', `/media/${GONE}/${variant}`, { ...who, headers: { range: 'bytes=0-' } })
			assert.equal(fetched.status, 404, `${variant}: ${fetched.text}`)
		}
	}

	assert.equal((await call('GET', `/media/${GONE}`, owner())).status, 404)
	for (const variant of ['asset', 'thumbnail']) {
		const put = await call('PUT', `/media/${GONE}/${variant}`, { ...owner(), body: randomBytes(200) })
		assert.equal(put.status, 404, `${variant}: ${put.text}`)
		assert.equal(await inBucket(`media/${GONE}/${variant}`), false, `the refused PUT wrote ${variant}`)
	}
})

test('5. a repeated DELETE is 404, identical to an id that never existed', async () => {
	assert.ok(erased, 'step 2 did not answer 204, so a 404 here proves nothing — an unrouted DELETE is 404 too')
	const repeated = await call('DELETE', `/media/${GONE}`, owner())
	const absent = await call('DELETE', `/media/${randomUUID()}`, owner())

	assert.equal(repeated.status, 404)
	assert.equal(repeated.text, absent.text)
})

test('6. a DELETE during an upload is 202, and the last upload out finishes the erasure', async () => {
	/*
	 * The case a 202 exists for, over a real socket: the PUT has been admitted
	 * and is still streaming when the DELETE arrives. Nothing retries the
	 * DELETE here — the upload, finishing onto a hidden row as the last one in
	 * flight, is what must leave the bucket and the table empty.
	 */
	const created = await call('POST', `/albums/${ALBUM_ID}/media`, {
		...owner(),
		body: { id: LATE, kind: 'photo', metadata: b64(randomBytes(120)) },
	})
	assert.equal(created.status, 201, created.text)
	const thumb = await call('PUT', `/media/${LATE}/thumbnail`, { ...owner(), body: randomBytes(512) })
	assert.equal(thumb.status, 200, thumb.text)

	// The asset PUT, held open after its first half.
	const body = randomBytes(8192)
	let request
	const response = new Promise((resolve, reject) => {
		request = http.request(`${base}/media/${LATE}/asset`, {
			method: 'PUT',
			headers: {
				authorization: `Bearer ${b64(ownerToken)}`,
				'content-type': 'application/octet-stream',
				'content-length': body.length,
			},
		})
		request.on('response', (res) => {
			let text = ''
			res.on('data', (chunk) => { text += chunk })
			res.on('end', () => resolve({ status: res.statusCode, text }))
		})
		request.on('error', reject)
		request.write(body.subarray(0, 4096))
	})

	try {
		// Admitted means counted: wait for the row to say so before deleting.
		const deadline = Date.now() + 5000
		for (;;) {
			const { rows } = await pool.query('SELECT uploads_in_flight FROM media WHERE id = $1', [LATE])
			if (rows[0]?.uploads_in_flight === 1) break
			assert.ok(Date.now() < deadline, 'the PUT was never admitted')
			await new Promise((r) => setTimeout(r, 25))
		}

		const removed = await call('DELETE', `/media/${LATE}`, owner())
		assert.equal(removed.status, 202, `an upload is in flight, so not erased yet: ${removed.text}`)
	} finally {
		// Always release the body, so a failed assertion above does not leave
		// the server holding the request until the upload deadline.
		request.end(body.subarray(4096))
	}

	const uploaded = await response
	assert.equal(uploaded.status, 404, uploaded.text)

	assert.equal(await inBucket(`media/${LATE}/asset`), false, 'the late asset is still in the bucket')
	assert.equal(await inBucket(`media/${LATE}/thumbnail`), false, 'the thumbnail is still in the bucket')
	const { rows } = await pool.query('SELECT 1 FROM media WHERE id = $1', [LATE])
	assert.equal(rows.length, 0, 'the row survived the last upload out')
})
