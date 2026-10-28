/*
 * The two hostnames the Mac-side scripts talk to. Production by default; the
 * disaster-recovery rehearsal sets both to temporary names (deploy/README.md),
 * so nothing it runs can reach production.
 *
 *   VITRINA_APP_HOST   default app.lirioapp.eu
 *   VITRINA_API_HOST   default api.lirioapp.eu
 */

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function host(name, fallback) {
  const value = process.env[name] || fallback;
  if (!HOST.test(value)) {
    console.error(`${name} is not a hostname: ${value}`);
    process.exit(2);
  }
  return value;
}

export const APP_HOST = host("VITRINA_APP_HOST", "app.lirioapp.eu");
export const API_HOST = host("VITRINA_API_HOST", "api.lirioapp.eu");
export const APP = `https://${APP_HOST}`;
export const API = `https://${API_HOST}`;
