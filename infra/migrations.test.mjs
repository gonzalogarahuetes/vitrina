import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

/*
 * The migration runner, against the live compose database.
 *
 * Belongs in `test:infra` and nowhere else: it needs Postgres, and `pnpm test`
 * stays Docker-free (ci.yml, job 1). The runner itself is exercised as a child
 * process, exactly as compose's `migrate` service runs it, so the exit code
 * under test is the one the wait script reads.
 *
 * Three properties, matching what schema §0 needs from the runner:
 *   1. a second run is a no-op — idempotence;
 *   2. schema_migrations is the directory, by filename and hash — what the
 *      database says was applied is what is on disk;
 *   3. an applied file whose hash no longer matches is refused and nothing is
 *      recorded — "an applied migration is never edited" as a failing command.
 *
 * And one property of a file rather than of the runner: 003 refuses to run on
 * a database that holds an album, because it replaces plaintext columns the
 * relay cannot encrypt, and its refusal rolls back whole. Likewise 005 fails on
 * a database already holding metadata under its floor, rather than adding the
 * constraint NOT VALID around it, and 006 refuses a database holding any QR
 * recipient, whose invite it cannot convert, while passing passphrase rows
 * through untouched.
 *
 * Property 3 runs against a scratch database created here, so it never
 * touches the stack's real one. It tampers with the *recorded* hash rather
 * than the file, which exercises the same comparison without a
 * directory-override knob on the runner that nothing else needs.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'
const SCRATCH_DB = 'vitrina_migrations_test'
const SCRATCH_URL = withDatabase(DATABASE_URL, SCRATCH_DB)
const GUARD_DB = 'vitrina_migrations_guard_test'
const GUARD_URL = withDatabase(DATABASE_URL, GUARD_DB)
const FLOOR_DB = 'vitrina_migrations_floor_test'
const FLOOR_URL = withDatabase(DATABASE_URL, FLOOR_DB)
const QR_DB = 'vitrina_migrations_qr_test'
const QR_URL = withDatabase(DATABASE_URL, QR_DB)

const RUNNER = fileURLToPath(new URL('../packages/server/scripts/migrate.mjs', import.meta.url))
const MIGRATIONS_DIR = new URL('../packages/server/migrations/', import.meta.url)
const FILE_NAMING_CONVENTION = /^(\d{3})_[a-z0-9_]+\.sql$/

function withDatabase(url, name) {
	const u = new URL(url)
	u.pathname = `/${name}`
	return u.toString()
}

/**
 * Run the migrator as compose does. Resolves for any exit code — the tests
 * assert on it — rather than throwing on non-zero as execFile would.
 */
function runMigrator(databaseUrl) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[RUNNER],
			{ env: { ...process.env, DATABASE_URL: databaseUrl } },
			(error, stdout, stderr) => {
				resolve({ code: error ? error.code : 0, stdout, stderr })
			},
		)
	})
}

/** What the runner should have recorded: every file on disk, by version. */
async function migrationsOnDisk() {
	const names = await readdir(MIGRATIONS_DIR)
	const files = []
	for (const name of names) {
		const match = name.match(FILE_NAMING_CONVENTION)
		if (!match) throw new Error(`not a migration file: ${name}`)
		const buf = await readFile(new URL(name, MIGRATIONS_DIR))
		files.push({
			version: Number(match[1]),
			filename: name,
			sha256: createHash('sha256').update(buf).digest('hex'),
		})
	}
	return files.sort((a, b) => a.version - b.version)
}

async function withClient(url, fn) {
	const client = new Client({ connectionString: url })
	await client.connect()
	try {
		return await fn(client)
	} finally {
		await client.end()
	}
}

async function recordedRows(url) {
	return withClient(url, async (client) => {
		const { rows } = await client.query(
			'SELECT version, filename, sha256 FROM schema_migrations ORDER BY version',
		)
		return rows
	})
}

before(async () => {
	// CREATE DATABASE cannot run inside a transaction; a bare query is fine.
	// DROP first so a crashed previous run does not poison this one.
	await withClient(DATABASE_URL, async (client) => {
		for (const db of [SCRATCH_DB, GUARD_DB, FLOOR_DB, QR_DB]) {
			await client.query(`DROP DATABASE IF EXISTS ${db}`)
			await client.query(`CREATE DATABASE ${db}`)
		}
	})
})

after(async () => {
	await withClient(DATABASE_URL, async (client) => {
		for (const db of [SCRATCH_DB, GUARD_DB, FLOOR_DB, QR_DB]) {
			await client.query(`DROP DATABASE IF EXISTS ${db}`)
		}
	})
})

test('a second run against a migrated database applies nothing and exits 0', async () => {
	const onDisk = await migrationsOnDisk()
	const { code, stdout, stderr } = await runMigrator(DATABASE_URL)
	assert.equal(code, 0, stderr)
	assert.match(stdout.trimEnd(), new RegExp(`0 applied, ${onDisk.length} already applied$`))
})

test('schema_migrations records exactly the files on disk, by filename and hash', async () => {
	const onDisk = await migrationsOnDisk()
	const recorded = await recordedRows(DATABASE_URL)
	assert.deepEqual(recorded, onDisk)
})

test('an applied file whose recorded hash no longer matches is refused', async () => {
	const onDisk = await migrationsOnDisk()

	const first = await runMigrator(SCRATCH_URL)
	assert.equal(first.code, 0, first.stderr)
	assert.match(first.stdout, new RegExp(`${onDisk.length} applied, 0 already applied`))

	// Simulate an edit to an applied file by moving the recorded hash away from
	// the file's real one. The runner must compare, not trust.
	await withClient(SCRATCH_URL, async (client) => {
		await client.query(
			"UPDATE schema_migrations SET sha256 = repeat('0', 64) WHERE version = 1",
		)
	})

	const second = await runMigrator(SCRATCH_URL)
	assert.equal(second.code, 1)
	assert.match(second.stderr, /has been edited/)
	assert.match(second.stderr, new RegExp(onDisk[0].filename))

	// Refusal recorded nothing and applied nothing: same rows, tampered hash intact.
	const rows = await recordedRows(SCRATCH_URL)
	assert.equal(rows.length, onDisk.length)
	assert.equal(rows[0].sha256, '0'.repeat(64))
})

test('003 refuses to run on a database that holds an album, and applies nothing', async () => {
	const first = await runMigrator(GUARD_URL)
	assert.equal(first.code, 0, first.stderr)

	// A database that would meet 003 holding an album, built without a
	// directory-override knob: migrate fully, add an album, then forget 003
	// and everything after it so the runner applies 003 again. The guard runs
	// before any DDL, so the post-003 column shapes do not change what it sees.
	await withClient(GUARD_URL, async (client) => {
		const {
			rows: [owner],
		} = await client.query(
			"INSERT INTO owners (email, auth_hash) VALUES ('guard@vitrina.test', $1) RETURNING id",
			[Buffer.alloc(32)],
		)
		await client.query(
			'INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
			[owner.id, Buffer.alloc(41), Buffer.alloc(48), Buffer.alloc(24)],
		)
		await client.query('DELETE FROM schema_migrations WHERE version >= 3')
	})

	const second = await runMigrator(GUARD_URL)
	assert.equal(second.code, 1)
	assert.match(second.stderr, /003_\w+\.sql: 003 cannot run on a database that holds albums/)

	// Rolled back whole: 003 is unrecorded and the album is untouched.
	await withClient(GUARD_URL, async (client) => {
		const { rows: versions } = await client.query('SELECT version FROM schema_migrations ORDER BY version')
		assert.deepEqual(
			versions.map((r) => r.version),
			[1, 2],
		)
		const { rows: albums } = await client.query('SELECT count(*)::int AS n FROM albums')
		assert.equal(albums[0].n, 1)
	})
})

test('005 refuses a database holding metadata under 81 bytes, and applies nothing', async () => {
	const first = await runMigrator(FLOOR_URL)
	assert.equal(first.code, 0, first.stderr)

	// A database that meets 005 holding a short envelope: migrate fully, forget
	// 005 and drop its constraint, then insert the row it would have refused.
	await withClient(FLOOR_URL, async (client) => {
		const {
			rows: [owner],
		} = await client.query(
			"INSERT INTO owners (email, auth_hash) VALUES ('floor@vitrina.test', $1) RETURNING id",
			[Buffer.alloc(32)],
		)
		const {
			rows: [album],
		} = await client.query(
			'INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id',
			[owner.id, Buffer.alloc(41), Buffer.alloc(48), Buffer.alloc(24)],
		)
		await client.query('DELETE FROM schema_migrations WHERE version >= 5')
		await client.query('ALTER TABLE media DROP CONSTRAINT "CHK_media_metadata_len"')
		await client.query(
			"INSERT INTO media (id, album_id, kind, metadata) VALUES (gen_random_uuid(), $1, 'photo', $2)",
			[album.id, Buffer.alloc(80)],
		)
	})

	const second = await runMigrator(FLOOR_URL)
	assert.equal(second.code, 1)
	assert.match(second.stderr, /005_\w+\.sql: .*"CHK_media_metadata_len".*violated by some row/)

	// Rolled back whole: 005 is unrecorded, no constraint exists, the row stays.
	await withClient(FLOOR_URL, async (client) => {
		const { rows: versions } = await client.query('SELECT max(version) AS v FROM schema_migrations')
		assert.equal(versions[0].v, 4)
		const { rows: constraints } = await client.query(
			"SELECT 1 FROM pg_constraint WHERE conname = 'CHK_media_metadata_len'",
		)
		assert.equal(constraints.length, 0)
		const { rows: media } = await client.query('SELECT octet_length(metadata) AS n FROM media')
		assert.deepEqual(media, [{ n: 80 }])
	})
})

test('006 refuses a database holding a QR recipient, applies nothing, and passes passphrase rows through', async () => {
	/*
	 * Migrate to 005, hold one QR and one passphrase recipient in their pre-006
	 * shapes, then let the runner meet 006. Built without a directory-override
	 * knob: migrate fully, forget 006, and put 005's constraints back, so the
	 * table is what 006 meets on a real pre-006 database.
	 */
	const first = await runMigrator(QR_URL)
	assert.equal(first.code, 0, first.stderr)

	const qrId = '00000000-0000-4000-8000-0000000000a1'
	const passphraseId = '00000000-0000-4000-8000-0000000000a2'

	await withClient(QR_URL, async (client) => {
		await client.query('DELETE FROM schema_migrations WHERE version >= 6')
		await client.query('ALTER TABLE recipients DROP CONSTRAINT "CHK_recipients_wrap_columns"')
		await client.query('ALTER TABLE recipients DROP CONSTRAINT "CHK_recipients_kdf_wrap_kind"')
		// 001's and 002's, verbatim in effect: all six NULL for qr.
		await client.query(`ALTER TABLE recipients ADD CONSTRAINT "CK_recipients_passphrase_columns" CHECK (
			num_nonnulls(wrapped, wrap_nonce, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism)
			= CASE kind WHEN 'passphrase' THEN 6 ELSE 0 END)`)
		await client.query(`ALTER TABLE recipients ADD CONSTRAINT "CHK_recipients_kdf_wrap_kind" CHECK (
			kind = 'qr' OR (octet_length(kdf_salt) = 16 AND octet_length(wrap_nonce) = 24
			AND octet_length(wrapped) = 48 AND kdf_memory_kib >= 16384 AND kdf_iterations >= 2
			AND kdf_parallelism >= 1))`)

		const {
			rows: [owner],
		} = await client.query(
			"INSERT INTO owners (email, auth_hash) VALUES ('qr@vitrina.test', $1) RETURNING id",
			[Buffer.alloc(32)],
		)
		const {
			rows: [album],
		} = await client.query(
			'INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id',
			[owner.id, Buffer.alloc(41), Buffer.alloc(48), Buffer.alloc(24)],
		)
		await client.query(
			"INSERT INTO recipients (id, album_id, kind, label, token_hash) VALUES ($1, $2, 'qr', $3, $4)",
			[qrId, album.id, Buffer.alloc(41), Buffer.alloc(32, 1)],
		)
		await client.query(
			`INSERT INTO recipients (id, album_id, kind, label, token_hash, wrapped, wrap_nonce,
			   kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism)
			 VALUES ($1, $2, 'passphrase', $3, $4, $5, $6, $7, 16384, 2, 1)`,
			[passphraseId, album.id, Buffer.alloc(41), Buffer.alloc(32, 2), Buffer.alloc(48, 7), Buffer.alloc(24, 8), Buffer.alloc(16, 9)],
		)
	})

	const refused = await runMigrator(QR_URL)
	assert.equal(refused.code, 1)
	assert.match(refused.stderr, /006_\w+\.sql: 006 cannot run on a database that holds QR recipients/)

	// Rolled back whole: 006 unrecorded, the old constraint still in place,
	// and the QR row untouched rather than "fixed".
	await withClient(QR_URL, async (client) => {
		const { rows: versions } = await client.query('SELECT max(version) AS v FROM schema_migrations')
		assert.equal(versions[0].v, 5)
		const { rows: constraints } = await client.query(
			"SELECT conname FROM pg_constraint WHERE conrelid = 'recipients'::regclass AND contype = 'c' ORDER BY conname",
		)
		assert.ok(constraints.some((c) => c.conname === 'CK_recipients_passphrase_columns'))
		assert.ok(!constraints.some((c) => c.conname === 'CHK_recipients_wrap_columns'))
		const { rows: qr } = await client.query('SELECT wrapped, wrap_nonce FROM recipients WHERE id = $1', [qrId])
		assert.deepEqual(qr, [{ wrapped: null, wrap_nonce: null }])
	})

	// With the QR row gone, as a reset development volume would be, 006
	// applies, and the passphrase row survives byte for byte under both new
	// constraints — validated on ADD, not NOT VALID.
	await withClient(QR_URL, (client) => client.query('DELETE FROM recipients WHERE id = $1', [qrId]))

	const applied = await runMigrator(QR_URL)
	assert.equal(applied.code, 0, applied.stderr)

	await withClient(QR_URL, async (client) => {
		const { rows: constraints } = await client.query(
			"SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'recipients'::regclass AND conname LIKE '%wrap%' ORDER BY conname",
		)
		assert.deepEqual(constraints, [
			{ conname: 'CHK_recipients_kdf_wrap_kind', convalidated: true },
			{ conname: 'CHK_recipients_wrap_columns', convalidated: true },
		])
		const { rows } = await client.query(
			"SELECT encode(wrapped, 'hex') AS w, encode(kdf_salt, 'hex') AS s FROM recipients WHERE id = $1",
			[passphraseId],
		)
		assert.deepEqual(rows, [{ w: '07'.repeat(48), s: '09'.repeat(16) }])
	})
})
