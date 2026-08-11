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

/** Stands in for ciphertext: the store must return these bytes unaltered. */
const BODY = randomBytes(OBJECT_SIZE)

/** Arithmetic, not scanning — the property the envelope design rests on. */
const chunkRange = (i) => ({
	start: i * CHUNK_SIZE,
	end: Math.min((i + 1) * CHUNK_SIZE, OBJECT_SIZE) - 1,
})

const presignGet = (expiresIn = 60) =>
	getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: KEY }), { expiresIn })

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
})

after(async () => {
	await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }))
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
