/*
 * Exact row counts of every table in `public`, as sorted JSON. Every table, not
 * a list: a list goes stale the first time a migration adds one.
 *
 *   DATABASE_URL=… node counts.mjs                 print {"albums": 2, …}
 *   DATABASE_URL=… node counts.mjs --expect-empty  exit 1 if any table exists
 *
 * Never prints DATABASE_URL — it carries a password.
 */

import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("counts.mjs: missing DATABASE_URL");
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  if (process.argv.includes("--expect-empty")) {
    if (rows.length) {
      console.error(`counts.mjs: database is not empty (${rows.length} tables)`);
      process.exitCode = 1;
    }
  } else {
    const counts = {};
    for (const { tablename } of rows) {
      const ident = client.escapeIdentifier(tablename);
      counts[tablename] = Number((await client.query(`SELECT count(*) AS n FROM public.${ident}`)).rows[0].n);
    }
    console.log(JSON.stringify(counts));
  }
} finally {
  await client.end();
}
