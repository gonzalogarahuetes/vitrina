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
 * Property 3 runs against a scratch database created here, so it never
 * touches the stack's real one. It tampers with the *recorded* hash rather
 * than the file, which exercises the same comparison without a
 * directory-override knob on the runner that nothing else needs.
 */

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/vitrina'
const SCRATCH_DB = 'vitrina_migrations_test'
const SCRATCH_URL = withDatabase(DATABASE_URL, SCRATCH_DB)

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
		await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
		await client.query(`CREATE DATABASE ${SCRATCH_DB}`)
	})
})

after(async () => {
	await withClient(DATABASE_URL, async (client) => {
		await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
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
