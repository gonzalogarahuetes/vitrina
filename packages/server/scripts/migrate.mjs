import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Relative to the script, never cwd — readdir/readFile accept URL objects.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

const DATABASE_URL = process.env.DATABASE_URL;
const FILE_NAMING_CONVENTION = /^(\d{3})_[a-z0-9_]+\.sql$/;
const TRANSACTION_CONVENTION = /^\s*(BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)\b/i;
const trackingTableQuery = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer     PRIMARY KEY,
    filename   text        NOT NULL UNIQUE,
    sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
    );
`;

if (!DATABASE_URL) {
    console.error("DATABASE_URL var is missing");
    process.exit(1);
};

const client = new Client({ connectionString: DATABASE_URL });

await client.connect().catch((error) => {
    const dbUrl = new URL(DATABASE_URL);
    console.error(`Could not connect to database ${dbUrl.pathname.slice(1)} and ${dbUrl.hostname}: ${error.message}`);
    process.exit(1);
});


try {
    await client.query({text: `SELECT pg_advisory_lock(7245311)`});
    
    await client.query({text: trackingTableQuery});
    
    const files = await readdir(MIGRATIONS_DIR);
    
    if(files.length === 0) {
        console.error("No files found. Please check if it is the correct location.");
        process.exitCode = 1;
        throw new Error(`no migration files in ${MIGRATIONS_DIR}`)
    }

    const sortedFiles = [];
    for (const name of files) {
        const match = name.match(FILE_NAMING_CONVENTION);
        if (!match) throw new Error(`Not a migration file: ${name}`);

        const buf = await readFile(new URL(name, MIGRATIONS_DIR));
        sortedFiles.push({
            version: Number(match[1]),
            name,
            text: buf.toString("utf8"),
            sha256: createHash("sha256").update(buf).digest("hex"),
        });
    }
    sortedFiles.sort((a, b) => a.version - b.version);

    for (let i = 0; i < sortedFiles.length; i++) {
        if(sortedFiles[i].version !== i + 1) {
            throw Error(`There are duplicated prefixes in the selected directory: expected version ${i + 1}, got ${sortedFiles[i].version} (${sortedFiles[i].name})`);
        }   
    }
    
    const result = await client.query({text: `SELECT version, filename, sha256 FROM schema_migrations ORDER BY version`});
    const filesByVersion = new Map();
    result.rows.forEach(row => {
        filesByVersion.set(row.version, row);
    });

    

    let firstUnrecorded = null;
    const toApply = [];

    for (const file of sortedFiles) {              // { version, name, text, sha256 }
        const row = filesByVersion.get(file.version);

        if (row) {
            if (firstUnrecorded) throw new Error(`${file.name} is recorded as applied but ${firstUnrecorded.name} before it is not`);
            if (row.filename !== file.name) throw new Error(`Invalid file: ${file.name} has been renamed`);
            if (row.sha256 !== file.sha256) throw new Error(`Invalid file: ${file.name} has been edited`);
            filesByVersion.delete(file.version);   // mark visited
            continue;
        }

        firstUnrecorded ??= file;
        if (file.version >= 3) { 
            const lines = file.text.split(/\r?\n/);
            const bad = lines.findIndex((l) => TRANSACTION_CONVENTION.test(l));
            if (bad !== -1) throw new Error(`${file.name}:${bad + 1}: transaction control belongs to the runner, not the file`);
        }
        toApply.push(file);
    }

    if (filesByVersion.size > 0) throw new Error(`recorded but missing from disk: ${[...filesByVersion.values()].map((r) => r.filename).join(", ")}`);


   for (const file of toApply) {
       await client.query("BEGIN");
       try {
           await client.query({ text: file.text });
           await client.query({
               text: "INSERT INTO schema_migrations (version, filename, sha256) VALUES ($1, $2, $3)",
               values: [file.version, file.name, file.sha256],
           });
           await client.query("COMMIT");
       } catch (error) {
           await client.query("ROLLBACK");
           throw new Error(`${file.name}: ${error.message}`);
       }
       process.stdout.write(`applied ${file.name}\n`);
   }
   process.stdout.write(`${toApply.length} applied, ${sortedFiles.length - toApply.length} already applied\n`);

} catch (error) {
    process.stderr.write(`Error migrating: ${error.message}\n`);
    process.exitCode = 1;
} finally {
    await client.end();
}