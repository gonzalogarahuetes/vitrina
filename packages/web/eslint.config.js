/*
 * typescript-eslint's parser here, not Babel's as in packages/server: this
 * package is on TypeScript 6 (SvelteKit and svelte-check do not support 7),
 * which typescript-eslint does support. Not type-aware; svelte-check covers types.
 */
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

/*
 * The one module that may touch sessionStorage, not yet written. The decision
 * behind it: the owner token and its `expires_at` live in sessionStorage
 * (flows §1.1), nothing else is stored anywhere, and recipient storage is
 * pending a device test (flows §4.7). Moving this path is a decision; make it
 * here, out loud.
 */
const SESSION_STORAGE_MODULE = "src/lib/session/owner-session.ts";

/* The one module that may make a request. */
const API_CLIENT_MODULE = "src/lib/api/client.ts";

const STORAGE =
  "Nothing is stored on this device except the owner token and its expiry, in sessionStorage, " +
  `and only from ${SESSION_STORAGE_MODULE} (flows §1.1; invite spec §2.2).`;
const NETWORK = `Every request goes through ${API_CLIENT_MODULE}: bearer auth, no cookies, no fragment in a URL.`;
const SW = "No service worker: one caching responses defeats Cache-Control: no-store on ciphertext (brief §10).";

const GLOBAL_OWNERS = ["window", "self", "globalThis", "document"];

/** [name, message, the one module allowed to use it (absent: none)] */
const BANNED = [
  ["localStorage", STORAGE],
  ["indexedDB", STORAGE],
  ["caches", STORAGE],
  ["cookieStore", STORAGE],
  ["sessionStorage", STORAGE, "session"],
  ["fetch", NETWORK, "client"],
  ["XMLHttpRequest", NETWORK],
  ["WebSocket", NETWORK],
  ["EventSource", NETWORK],
];

function restrictions(except) {
  const names = BANNED.filter(([, , allowedIn]) => allowedIn === undefined || allowedIn !== except);
  return {
    "no-restricted-globals": ["error", ...names.map(([name, message]) => ({ name, message }))],
    "no-restricted-properties": [
      "error",
      ...names.flatMap(([property, message]) => GLOBAL_OWNERS.map((object) => ({ object, property, message }))),
      { object: "document", property: "cookie", message: STORAGE },
      { object: "navigator", property: "storage", message: STORAGE },
      { object: "navigator", property: "sendBeacon", message: NETWORK },
      { object: "navigator", property: "serviceWorker", message: SW },
    ],
  };
}

export default ts.config(
  { ignores: [".svelte-kit/**", "build/**", "node_modules/**"] },
  ...svelte.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { parser: ts.parser },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  { files: ["**/*.ts", "**/*.js", "**/*.svelte"], rules: restrictions(undefined) },
  { files: [SESSION_STORAGE_MODULE], rules: restrictions("session") },
  { files: [API_CLIENT_MODULE], rules: restrictions("client") },
  {
    // Config and Node-side scripts run at build time, not in the browser.
    files: ["vite.config.ts", "vite-plugins.ts", "eslint.config.js", "scripts/**"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
);
