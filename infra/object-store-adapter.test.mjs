import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'

import {
	createObjectStore,
	verifyBucket,
} from '../packages/server/dist/adapters/driven/s3/object-store.js'

/*
 * The S3 ObjectStore adapter, against the live compose bucket.
 *
 * Distinct from object-store.test.mjs beside it: that one probes what
 * SeaweedFS itself does — presigning, ranges, Cache-Control — and answers
 * "can the store do what brief §10 needs". This one asserts the adapter
 * behind api-sketch §9.7's port, and the difference matters most in one
 * place: the port returns `null` for an absent object and THROWS for an
 * unreachable store, and only a real store shows that those two are told
 * apart correctly.
 *
 * Expected export:  createObjectStore(client: S3Client, bucket: string): ObjectStore
 *
 * NOT HERE: what happens to a body that stops short of its declared
 * Content-Length. Two tests for it were removed on 25 September 2026 after
 * they exhausted a 4 GB heap — SeaweedFS does not reject a short body, it
 * waits for the rest, and driving that from a test is neither cheap nor
 * deterministic. The property §9.7 needs is that the use case's own byte
 * count disagrees with the confirming HEAD, which is use-case logic and
 * belongs in a hermetic test over a fake store.
 *
 * Run `pnpm test` first — it compiles packages/server, which this imports
 * from dist/.
 */

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

/**
 * Every client is tracked and destroyed in `after`. An undestroyed S3Client
 * keeps its agent's sockets alive, which keeps the event loop alive, which
 * makes the runner sit on the file until it gives up — reported as a
 * file-level failure with no failing assertion in it.
 */
const clients = []
const clientFor = (overrides = {}) => {
	const created = new S3Client({
		endpoint: ENDPOINT,
		region: REGION,
		credentials: credentialsFromS3Config(),
		forcePathStyle: true, // not optional against SeaweedFS
		...overrides,
	})
	clients.push(created)
	return created
}

const client = clientFor()
const store = createObjectStore(client, BUCKET)

/** Opaque, as `domain/media/object-key.ts` produces. No filename, ever. */
const key = () => `media/${randomUUID()}/asset`

/** Written keys, for the cleanup below. */
const written = []
const put = async (bytes, k = key()) => {
	written.push(k)
	await store.put(k, Readable.from([bytes]), bytes.length)
	return k
}

after(async () => {
	for (const k of written) {
		await client
			.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k }))
			.catch(() => {})
	}
	for (const created of clients) created.destroy()
})

before(async () => {
	try {
		await store.head(key())
	} catch (cause) {
		throw new Error(
			`cannot reach the bucket "${BUCKET}" at ${ENDPOINT}. Start the stack ` +
				'with `pnpm infra:up && pnpm infra:wait`. SeaweedFS has NO healthcheck, ' +
				'so `up` returns before it can serve and createbucket races it.',
			{ cause },
		)
	}
})

test('a streamed put is readable back at the length it was given', async () => {
	// 300 KiB, so the body spans more than one 256 KiB chunk and the stream is
	// genuinely streamed rather than handed over as one buffer.
	const bytes = Buffer.alloc(300 * 1024, 0x5a)
	const k = await put(bytes)

	const found = await store.head(k)

	assert.ok(found, 'the object is not there after a successful put')
	assert.strictEqual(found.length, bytes.length)
})

test('head returns null for an object that was never written', async () => {
	/*
	 * §9.7 leans on this: a not-found cannot distinguish "failed to land" from
	 * "not yet published", so absence leaves the row `processing` and the
	 * client retries §9.8. A throw here would mark the row failed instead.
	 */
	assert.equal(await store.head(key()), null)
})

test('head THROWS when the store cannot be reached', async () => {
	/*
	 * The assertion this file exists for, and the one that cannot be written
	 * against a fake. If an unreachable store came back as `null` the two
	 * outcomes would be one, and a network blip would read as "the object is
	 * not there" — which under §9.7 leaves every upload stalled at
	 * `processing` with nothing saying why.
	 *
	 * A port that is closed rather than a host that does not resolve, so the
	 * failure is fast and does not depend on DNS.
	 */
	const unreachable = createObjectStore(
		clientFor({ endpoint: 'http://localhost:9', maxAttempts: 1 }),
		BUCKET,
	)

	await assert.rejects(
		() => unreachable.head(key()),
		(error) => {
			assert.equal(error.name, 'StorageError', `got ${error.name}: ${error.message}`)
			assert.equal(error.code, 'UNAVAILABLE')
			return true
		},
	)
})

test('head CANNOT tell a missing bucket from a missing object', async () => {
	/*
	 * Measured, not assumed — this file first asserted the opposite and was
	 * wrong. A HEAD carries no response body, so `NoSuchBucket` is unreadable
	 * and SeaweedFS answers the same 404 it gives for an absent object. The
	 * adapter maps that to `null`, correctly, because it has nothing else to
	 * go on.
	 *
	 * Which is the whole argument for verifyBucket below: the ambiguity is
	 * real and unresolvable per request, so it is ruled out once at boot.
	 */
	const wrongBucket = createObjectStore(clientFor(), `nope-${randomUUID()}`)

	assert.equal(await wrongBucket.head(key()), null)
})

test('verifyBucket rejects for a bucket that does not exist', async () => {
	// Where the misconfiguration is caught instead, before the socket opens.
	const missing = `nope-${randomUUID()}`

	await assert.rejects(
		() => verifyBucket(clientFor(), missing, ENDPOINT),
		(error) => {
			assert.equal(error.name, 'StorageError')
			assert.equal(error.code, 'UNAVAILABLE')
			// The operator needs both, and the SDK's own message names neither.
			assert.match(error.cause.message, new RegExp(missing))
			assert.match(error.cause.message, /localhost:8333|8333/)
			return true
		},
	)
})

test('verifyBucket resolves for the real bucket', async () => {
	// Otherwise the assertion above passes against a verifyBucket that always
	// throws, which would fail every boot.
	await verifyBucket(clientFor(), BUCKET, ENDPOINT)
})

test('put overwrites, because re-upload before ready is the same key', async () => {
	// §9.7 permits re-upload in pending, processing and failed: PUT replaces
	// the object, so the second attempt must win rather than conflict.
	const k = key()
	await put(Buffer.alloc(2048, 0x01), k)
	await put(Buffer.alloc(4096, 0x02), k)

	assert.strictEqual((await store.head(k)).length, 4096)
})

test('the object key is used verbatim, prefixes and all', async () => {
	// `media/{id}/asset` and `media/{id}/thumbnail` are two objects under one
	// prefix, and they must not collide or be rewritten by the adapter.
	const id = randomUUID()
	const asset = await put(Buffer.alloc(1024, 0xaa), `media/${id}/asset`)
	const thumb = await put(Buffer.alloc(512, 0xbb), `media/${id}/thumbnail`)

	assert.strictEqual((await store.head(asset)).length, 1024)
	assert.strictEqual((await store.head(thumb)).length, 512)
})

test('a StorageError carries no SDK metadata into the log', async () => {
	/*
	 * `errWithCause` copies a cause's enumerable own properties, and an SDK
	 * error carries `$metadata` and the request it made. The adapter must
	 * chain a message it wrote — the key is safe to name, since it holds a
	 * uuid and no filename.
	 */
	const unreachable = createObjectStore(
		clientFor({ endpoint: 'http://localhost:9', maxAttempts: 1 }),
		BUCKET,
	)

	const error = await unreachable.head(key()).then(
		() => null,
		(caught) => caught,
	)

	assert.ok(error, 'expected a rejection')
	assert.equal(error.$metadata, undefined)
	assert.equal(error.cause?.$metadata, undefined)
})
