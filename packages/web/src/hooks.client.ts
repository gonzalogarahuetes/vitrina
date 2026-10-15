import { captureInvite } from "$lib/recipient/entry";

/* Runs before SvelteKit's router reads the URL: see lib/recipient/entry.ts. */
export function init(): void {
  captureInvite(window.location, window.history);
}
