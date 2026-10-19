/*
 * The top-100k password blocklist (brief §12). The owner supplies the file,
 * as with the font: it is not downloaded, here or at build time.
 *
 * Only signup reaches this module, and only through a dynamic import
 * (routes/+page.svelte's loadBlocklist), so it is a chunk of its own. The
 * recipient path never loads it, and check-build.mjs fails a build where any
 * chunk imports it statically. It is bundled rather than fetched at runtime
 * because connect-src names the API origin alone.
 */
import raw from "./passwords-top-100k.txt?raw";
import { parseBlocklist } from "./policy";

export const BLOCKLIST: ReadonlySet<string> = parseBlocklist(raw);

// An empty list would let every common password through without a sign. The
// message is also how check-build.mjs finds this chunk: keep the two in step.
if (BLOCKLIST.size === 0) throw new Error("vitrina:password-blocklist is empty");
