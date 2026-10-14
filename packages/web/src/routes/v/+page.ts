// The recipient route. `https://{relay}/v/#…` is a permanent format (invite
// spec §2, §6), so the trailing slash is canonical: a redirect to /v would be
// one more hop for a URL that must not change.
export const trailingSlash = "always";
