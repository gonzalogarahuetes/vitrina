import { captureStartDepth } from "$lib/history";
import { captureInvite } from "$lib/recipient/entry";

/* Runs before SvelteKit's router reads the URL: see lib/recipient/entry.ts and lib/history.ts. */
export function init(): void {
  captureStartDepth(window.history);
  captureInvite(window.location, window.history);
}
