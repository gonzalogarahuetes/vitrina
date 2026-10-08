import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'

import { buildComposition } from '../packages/server/dist/composition-root.js'
import { buildServer } from '../packages/server/dist/adapters/driving/http/server.js'

// PR 5's done-when — the recipient journey end to end, over the real composition
// root, Postgres, SeaweedFS, a socket and the envelope crate. The point is the
// last steps: the access log's claims checked against behaviour, not prose.

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'
const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:8333'
const BUCKET = process.env.S3_BUCKET ?? 'vitrina-media'
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
const WASM_DIR = new URL('../packages/envelope/wasm/', import.meta.url)

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
/** A uuid as the 16 raw bytes every AAD carries (encryption spec §6.2). */
const idBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex')

const OWNER_EMAIL = `pr5-${randomUUID()}@x.es`
const ALBUM_ID = randomUUID()
const MEDIA_ID = randomUUID()
const TITLE = 'Verano 2026 · la playa'
const LABEL = 'María'
const PASSPHRASE = 'tortilla de patatas con cebolla'
/** Above 002's floors and not WrapParams.v1(), as pr4-routes.test.mjs explains. */
const PARAMS = { memoryKib: 20480, iterations: 5, parallelism: 3 }

/** Under one 256 KiB chunk, so `bytes=0-` is the header plus chunk 0 — the open. */
const PHOTO = randomBytes(40 * 1024)
const THUMB = randomBytes(6 * 1024)
const META = Buffer.from(JSON.stringify({ width: 1600, height: 1200 }))

let envelope
let app
let pool
let s3
let base
let ownerToken
let albumKey
const recipient = { id: randomUUID(), token: randomBytes(32) }
let recovered // K_album as the recipient's client unwrapped it

before(async () => {
	try {
		const { default: init, ...exports } = await import(new URL('envelope.js', WASM_DIR))
		await init({ module_or_path: await readFile(new URL('envelope_bg.wasm', WASM_DIR)) })
		envelope = exports
	} catch (cause) {
		throw new Error('cannot load the envelope WASM build — `pnpm --filter @vitrina/envelope build:wasm`.', { cause })
	}

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
		// albums, media, recipients and access_log cascade.
		await pool.query('DELETE FROM owners WHERE email = $1', [OWNER_EMAIL])
		await pool.end()
	}
	for (const variant of ['asset', 'thumbnail']) {
		await s3?.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `media/${MEDIA_ID}/${variant}` })).catch(() => {})
	}
	s3?.destroy()
})

/** JSON in, JSON or raw bytes out, over a real socket. */
async function call(method, path, { body, token, headers = {}, raw = false } = {}) {
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
	const bytes = Buffer.from(await response.arrayBuffer())
	const text = raw ? '' : bytes.toString('utf8')
	return { status: response.status, headers: response.headers, bytes, text, body: !raw && text ? JSON.parse(text) : null }
}

const logRows = async () =>
	(
		await pool.query(
			'SELECT event, media_id FROM access_log WHERE recipient_id = $1 ORDER BY id',
			[recipient.id],
		)
	).rows

test('1. the owner publishes: an album, a ready photo, a passphrase invite', async () => {
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

	const media = await call('POST', `/albums/${ALBUM_ID}/media`, {
		token: ownerToken,
		body: { id: MEDIA_ID, kind: 'photo', metadata: b64(envelope.encryptMeta(albumKey, idBytes(MEDIA_ID), META)) },
	})
	assert.equal(media.status, 201, media.text)
	const asset = await call('PUT', `/media/${MEDIA_ID}/asset`, {
		token: ownerToken,
		body: Buffer.from(envelope.encryptAsset(albumKey, idBytes(MEDIA_ID), PHOTO)),
	})
	assert.equal(asset.status, 200, asset.text)
	const thumb = await call('PUT', `/media/${MEDIA_ID}/thumbnail`, {
		token: ownerToken,
		body: Buffer.from(envelope.encryptThumb(albumKey, idBytes(MEDIA_ID), THUMB)),
	})
	assert.equal(thumb.body.status, 'ready', thumb.text)

	const wrapping = envelope.wrapAlbumKey(
		albumKey,
		PASSPHRASE,
		new envelope.WrapParams(PARAMS.memoryKib, PARAMS.iterations, PARAMS.parallelism),
		idBytes(recipient.id),
	)
	const invited = await call('POST', `/albums/${ALBUM_ID}/recipients`, {
		token: ownerToken,
		body: {
			id: recipient.id,
			kind: 'passphrase',
			label: b64(envelope.encryptRecipientLabel(albumKey, idBytes(recipient.id), LABEL)),
			token_hash: b64(sha256(recipient.token)),
			wrapped: b64(wrapping.wrapped),
			wrap_nonce: b64(wrapping.wrapNonce),
			kdf_salt: b64(wrapping.kdfSalt),
			kdf_memory_kib: PARAMS.memoryKib,
			kdf_iterations: PARAMS.iterations,
			kdf_parallelism: PARAMS.parallelism,
		},
	})
	assert.equal(invited.status, 201, invited.text)
})

test('2. the recipient opens the invite: their own row, then the key, then K_album', async () => {
	const self = await call('GET', '/recipient', { token: recipient.token })
	assert.equal(self.status, 200, self.text)
	assert.equal(self.body.album_id, ALBUM_ID)

	const key = await call('GET', '/recipient/key', { token: recipient.token })
	assert.equal(key.status, 200, key.text)
	recovered = envelope.unwrapAlbumKey(
		PASSPHRASE,
		new envelope.WrapParams(key.body.kdf_memory_kib, key.body.kdf_iterations, key.body.kdf_parallelism),
		idBytes(key.body.id),
		envelope.WrappedKey.fromParts(unb64(key.body.wrapped), unb64(key.body.wrap_nonce), unb64(key.body.kdf_salt)),
	)

	// The watermark's input (brief §5), opened with the key the recipient now holds.
	assert.equal(envelope.decryptRecipientLabel(recovered, idBytes(recipient.id), unb64(self.body.label)), LABEL)
})

test('3. reads the album: details, then every metadata envelope', async () => {
	const details = await call('GET', `/albums/${ALBUM_ID}`, { token: recipient.token })
	assert.equal(details.status, 200, details.text)
	assert.equal(envelope.decryptAlbumTitle(recovered, idBytes(ALBUM_ID), unb64(details.body.title)), TITLE)

	const metadata = await call('GET', `/albums/${ALBUM_ID}/metadata`, { token: recipient.token })
	assert.equal(metadata.status, 200, metadata.text)
	const [row] = metadata.body.metadata
	assert.equal(row.media_id, MEDIA_ID)
	assert.deepEqual(Buffer.from(envelope.decryptMeta(recovered, idBytes(MEDIA_ID), unb64(row.envelope))), META)
})

test('4. fetches the thumbnail — whole, Range ignored — and it decrypts', async () => {
	const thumb = await call('GET', `/media/${MEDIA_ID}/thumbnail`, {
		token: recipient.token,
		headers: { range: 'bytes=0-10' },
		raw: true,
	})

	assert.equal(thumb.status, 200)
	assert.equal(thumb.headers.get('content-range'), null)
	assert.deepEqual(Buffer.from(envelope.decryptThumb(recovered, idBytes(MEDIA_ID), thumb.bytes)), THUMB)
})

test('5. opens the photo with a range from byte 0, and it decrypts', async () => {
	const opened = await call('GET', `/media/${MEDIA_ID}/asset`, {
		token: recipient.token,
		headers: { range: 'bytes=0-' },
		raw: true,
	})

	assert.equal(opened.status, 206)
	assert.equal(opened.headers.get('cache-control'), 'no-store')
	assert.match(opened.headers.get('content-range'), new RegExp(`^bytes 0-${opened.bytes.length - 1}/${opened.bytes.length}$`))
	assert.deepEqual(Buffer.from(envelope.decryptAsset(recovered, idBytes(MEDIA_ID), opened.bytes)), PHOTO)
})

test('6. a later range on the same photo is served, and is not an open', async () => {
	const later = await call('GET', `/media/${MEDIA_ID}/asset`, {
		token: recipient.token,
		headers: { range: 'bytes=64-' },
		raw: true,
	})

	assert.equal(later.status, 206)
})

test('7. the log holds exactly one album_opened and one asset_viewed — nothing for the thumbnail', async () => {
	/*
	 * The assertion PR 5 exists for. Six recipient requests above; two are
	 * opens. §9.4, §11.4, the key, the thumbnail and the later range wrote
	 * nothing, and the two that did are in the order they happened.
	 */
	assert.deepEqual(await logRows(), [
		{ event: 'album_opened', media_id: null },
		{ event: 'asset_viewed', media_id: MEDIA_ID },
	])
})

test("8. the owner's own fetches add nothing — the table has no owner", async () => {
	await call('GET', `/albums/${ALBUM_ID}/metadata`, { token: ownerToken })
	await call('GET', `/media/${MEDIA_ID}/asset`, { token: ownerToken, headers: { range: 'bytes=0-63' }, raw: true })

	assert.equal((await logRows()).length, 2)
	const { rows } = await pool.query(
		'SELECT count(*)::int AS n FROM access_log l JOIN recipients r ON r.id = l.recipient_id WHERE r.album_id = $1',
		[ALBUM_ID],
	)
	assert.equal(rows[0].n, 2)
})

test('9. the owner reads it back through §11.7: one open, one photo opened', async () => {
	const summary = await call('GET', `/albums/${ALBUM_ID}/access-log`, { token: ownerToken })
	assert.equal(summary.status, 200, summary.text)
	const [row] = summary.body.recipients
	assert.equal(row.recipient_id, recipient.id)
	assert.deepEqual([row.album_opens, row.media_opened], [1, 1])
	assert.equal(envelope.decryptRecipientLabel(albumKey, idBytes(recipient.id), unb64(row.label)), LABEL)

	const entries = await call('GET', `/albums/${ALBUM_ID}/access-log/entries`, { token: ownerToken })
	assert.equal(entries.status, 200, entries.text)
	assert.deepEqual(entries.body.entries.map((e) => e.event), ['asset_viewed', 'album_opened'])
	assert.equal(entries.body.next_before, null)
})
