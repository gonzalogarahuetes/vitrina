import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadBucketCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:8333'
const BUCKET = process.env.S3_BUCKET ?? 'vitrina-media'
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1'

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

const s3 = new S3Client({
	endpoint: ENDPOINT,
	region: REGION,
	credentials: credentialsFromS3Config(),
	forcePathStyle: true, // no virtual-host-style DNS against localhost
})

/**
 * 256 KiB is the spec's chunk size. The object is deliberately not a whole
 * number of chunks: the last chunk is 1 KiB, so the final-chunk range is a
 * partial one.
 */
const CHUNK_SIZE = 256 * 1024
const LAST_CHUNK_SIZE = 1024
const CHUNK_COUNT = 3
const OBJECT_SIZE = (CHUNK_COUNT - 1) * CHUNK_SIZE + LAST_CHUNK_SIZE

/** Opaque key. Plaintext filenames must never reach the server, keys included. */
const KEY = `test/${randomBytes(16).toString('hex')}`

/** Same, for the object written with Cache-Control as stored object metadata. */
const CACHE_CONTROL_KEY = `test/${randomBytes(16).toString('hex')}`

/**
 * What we want on every ciphertext response. `no-store` rather than `no-cache`:
 * the recipient's browser and any intermediary must not retain the bytes at all,
 * not merely revalidate before reusing them.
 */
const CACHE_CONTROL = 'no-store'

/** Stands in for ciphertext: the store must return these bytes unaltered. */
const BODY = randomBytes(OBJECT_SIZE)

/** Arithmetic, not scanning — the property the envelope design rests on. */
const chunkRange = (i) => ({
	start: i * CHUNK_SIZE,
	end: Math.min((i + 1) * CHUNK_SIZE, OBJECT_SIZE) - 1,
})

const presignGet = (expiresIn = 60) =>
	getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: KEY }), { expiresIn })

/** Presigns a GET carrying the per-request `response-cache-control` override. */
const presignGetWithCacheControlOverride = (key = KEY, expiresIn = 60) =>
	getSignedUrl(
		s3,
		new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseCacheControl: CACHE_CONTROL }),
		{ expiresIn },
	)

before(async () => {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
	} catch (cause) {
		throw new Error(
			`cannot reach bucket "${BUCKET}" at ${ENDPOINT}. Start the stack with ` +
				`\`pnpm infra:up\` and check the createbucket service succeeded.`,
			{ cause },
		)
	}
	await s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: KEY,
			Body: BODY,
			ContentType: 'application/octet-stream',
		}),
	)
	await s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: CACHE_CONTROL_KEY,
			Body: BODY,
			ContentType: 'application/octet-stream',
			CacheControl: CACHE_CONTROL,
		}),
	)
})

after(async () => {
	await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }))
	await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: CACHE_CONTROL_KEY }))
})

test('a presigned URL serves the whole object', async () => {
	const url = await presignGet()
	assert.match(url, /X-Amz-Signature=/, 'URL is not presigned')

	const res = await fetch(url)
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('content-length'), String(OBJECT_SIZE))
	assert.equal(res.headers.get('accept-ranges'), 'bytes', 'store does not advertise ranges')

	const body = Buffer.from(await res.arrayBuffer())
	assert.equal(body.length, OBJECT_SIZE)
	assert.ok(body.equals(BODY), 'round-tripped bytes differ from what was written')
})

test('a range-GET of the first chunk returns 206 and the right bytes', async () => {
	const { start, end } = chunkRange(0)
	const res = await fetch(await presignGet(), { headers: { Range: `bytes=${start}-${end}` } })

	assert.equal(res.status, 206)
	assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${OBJECT_SIZE}`)
	assert.equal(res.headers.get('content-length'), String(CHUNK_SIZE))

	const body = Buffer.from(await res.arrayBuffer())
	assert.ok(body.equals(BODY.subarray(start, end + 1)), 'chunk 0 bytes are wrong')
})

test('a range-GET of a middle chunk returns 206 and the right bytes', async () => {
	const { start, end } = chunkRange(1)
	const res = await fetch(await presignGet(), { headers: { Range: `bytes=${start}-${end}` } })

	assert.equal(res.status, 206)
	assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${OBJECT_SIZE}`)
	assert.equal(res.headers.get('content-length'), String(CHUNK_SIZE))

	const body = Buffer.from(await res.arrayBuffer())
	assert.ok(body.equals(BODY.subarray(start, end + 1)), 'chunk 1 bytes are wrong')
	// Chunk 1 was fetched without ever touching chunk 0. That is the property
	// Phase 3 seeking depends on, at the transport layer.
	assert.notEqual(start, 0)
})

test('a range-GET of the partial final chunk returns 206 and the right bytes', async () => {
	const { start, end } = chunkRange(CHUNK_COUNT - 1)
	assert.equal(end - start + 1, LAST_CHUNK_SIZE, 'test fixture is not a partial final chunk')

	const res = await fetch(await presignGet(), { headers: { Range: `bytes=${start}-${end}` } })

	assert.equal(res.status, 206)
	assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${OBJECT_SIZE}`)
	assert.equal(res.headers.get('content-length'), String(LAST_CHUNK_SIZE))

	const body = Buffer.from(await res.arrayBuffer())
	assert.ok(body.equals(BODY.subarray(start)), 'final chunk bytes are wrong')
})

test('an open-ended range serves to the end of the object', async () => {
	const start = (CHUNK_COUNT - 1) * CHUNK_SIZE
	const res = await fetch(await presignGet(), { headers: { Range: `bytes=${start}-` } })

	assert.equal(res.status, 206)
	assert.equal(
		res.headers.get('content-range'),
		`bytes ${start}-${OBJECT_SIZE - 1}/${OBJECT_SIZE}`,
	)

	const body = Buffer.from(await res.arrayBuffer())
	assert.ok(body.equals(BODY.subarray(start)), 'open-ended range bytes are wrong')
})

test('a range past the end of the object is refused', async () => {
	const res = await fetch(await presignGet(), {
		headers: { Range: `bytes=${OBJECT_SIZE}-${OBJECT_SIZE + 1024}` },
	})

	assert.equal(res.status, 416, 'expected Range Not Satisfiable')
})

// The three tests below stop the presigning tests from passing vacuously: if
// an unsigned GET worked, the signature would be decoration.

test('an unsigned GET is denied', async () => {
	const url = new URL(await presignGet())
	const res = await fetch(`${url.origin}${url.pathname}`)

	assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
})

test('a tampered signature is denied', async () => {
	const url = new URL(await presignGet())
	const signature = url.searchParams.get('X-Amz-Signature')
	const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0')
	url.searchParams.set('X-Amz-Signature', flipped)

	const res = await fetch(url)
	assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
})

test('an expired presigned URL is denied', async () => {
	const url = await presignGet(1)
	await new Promise((resolve) => setTimeout(resolve, 2_000))

	const res = await fetch(url)
	assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
})

// Cache-Control, two mechanisms.
//
// A store that will not emit `no-store` on ciphertext responses is a finding:
// the bytes are decryptable by whoever holds the key, and a disk cache keeps
// them past the point where the recipient's tab is closed.
//
// Stored object metadata (A, B) is the mechanism to prefer — set once at upload,
// returned on every GET, with no per-request query parameter for a client to
// alter. The `response-cache-control` override (C, D, E) is the per-request
// alternative and is the one that has to be probed adversarially: it travels in
// the query string, so if the store honours it *unsigned*, a recipient can swap
// `no-store` for `max-age=31536000` and have their browser retain the ciphertext.
// That is the case a happy-path assertion never reaches.

test('Cache-Control set as object metadata is returned on a whole-object GET', async () => {
	const url = await getSignedUrl(
		s3,
		new GetObjectCommand({ Bucket: BUCKET, Key: CACHE_CONTROL_KEY }),
		{ expiresIn: 60 },
	)

	const res = await fetch(url)
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('cache-control'), CACHE_CONTROL)
})

test('Cache-Control set as object metadata survives a range-GET', async () => {
	// Every real request for an asset is ranged, so a store that emits the header
	// on 200s and drops it on 206s would be useless to us in practice.
	const { start, end } = chunkRange(1)
	const url = await getSignedUrl(
		s3,
		new GetObjectCommand({ Bucket: BUCKET, Key: CACHE_CONTROL_KEY }),
		{ expiresIn: 60 },
	)

	const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
	assert.equal(res.status, 206)
	assert.equal(res.headers.get('cache-control'), CACHE_CONTROL)
})

test('the response-cache-control override is honoured on a whole-object GET', async () => {
	const url = await presignGetWithCacheControlOverride()
	assert.match(url, /response-cache-control=/, 'SDK did not put the override in the query string')

	const res = await fetch(url)
	assert.equal(res.status, 200)
	assert.equal(res.headers.get('cache-control'), CACHE_CONTROL)
})

test('a tampered response-cache-control override is denied', async () => {
	// The assertion that decides whether the override is a control or a
	// decoration. It is covered by the SigV4 signature, so altering the value
	// must invalidate the URL rather than change the header we get back.
	const url = await presignGetWithCacheControlOverride()
	const tampered = url.replace('response-cache-control=no-store', 'response-cache-control=max-age%3D31536000')
	assert.notEqual(tampered, url, 'tamper did not apply — the assertion below would pass vacuously')

	const res = await fetch(tampered)
	assert.ok(
		res.status === 401 || res.status === 403,
		`expected 401/403 for a tampered override, got ${res.status}. If the store served ` +
			`this, response-cache-control is client-controllable and cannot be relied on; ` +
			`Cache-Control must be set as object metadata at upload time instead.`,
	)
})

test('removing the response-cache-control override is denied', async () => {
	// The other half of the same threat: a recipient who cannot forge a longer
	// max-age may still try simply dropping the parameter to get an unrestricted
	// response. Deleting a signed query parameter must also break the signature.
	const url = await presignGetWithCacheControlOverride()
	const stripped = url
		.replace('&response-cache-control=no-store', '')
		.replace('response-cache-control=no-store&', '')
	assert.notEqual(stripped, url, 'strip did not apply — the assertion below would pass vacuously')

	const res = await fetch(stripped)
	assert.ok(
		res.status === 401 || res.status === 403,
		`expected 401/403 after stripping the override, got ${res.status}`,
	)
})

test('the response-cache-control override survives a range-GET', async () => {
	const { start, end } = chunkRange(1)
	const url = await presignGetWithCacheControlOverride()

	const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
	assert.equal(res.status, 206)
	assert.equal(res.headers.get('cache-control'), CACHE_CONTROL)
})
