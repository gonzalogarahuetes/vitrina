/*
 * From 003 on, a migration carries no transaction control: the runner wraps
 * each file so its DDL and its schema_migrations row commit together
 * (migrate.mjs). This finds the first line that would take that over.
 *
 * Text that is not a statement is blanked before scanning — dollar-quoted
 * bodies and block comments — keeping every newline, so a reported line
 * number still points at the file. Without that, a PL/pgSQL DO block, whose
 * body opens with BEGIN and closes with END, reads as transaction control, and
 * so does any COMMENT ON body with a prose line that happens to start with
 * "End" or "Commit". 003's guard was the first file to hit it.
 *
 * Skipping those bodies gives nothing away. Inside the runner's transaction a
 * COMMIT or ROLLBACK in a DO block fails at run time with "invalid transaction
 * termination" rather than ending the transaction, so the only transaction
 * control that can actually escape is at statement level, which is still
 * scanned.
 *
 * Single-quoted strings are not blanked. A multi-line string literal whose
 * line starts with one of these words is refused; that is a false positive in
 * the safe direction, and dollar quoting is the house style for long text.
 */

const TRANSACTION_CONVENTION = /^\s*(BEGIN|COMMIT|ROLLBACK|END|START TRANSACTION)\b/i;

// Leftmost match wins, so a dollar quote inside a block comment, or a
// block-comment opener inside a dollar-quoted body, is consumed by whichever
// opened first. A tag cannot start with a digit, which keeps positional
// parameters out of it.
const NOT_STATEMENTS = /\/\*[\s\S]*?\*\/|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;

/** Replaces every character of non-statement text with a space, except newlines. */
export function blankNonStatements(sql) {
    return sql.replace(NOT_STATEMENTS, (match) => match.replace(/[^\n]/g, " "));
}

/** The 1-based line of the first transaction-control statement, or null. */
export function findTransactionControl(sql) {
    const lines = blankNonStatements(sql).split(/\r?\n/);
    const index = lines.findIndex((line) => TRANSACTION_CONVENTION.test(line));
    return index === -1 ? null : index + 1;
}
