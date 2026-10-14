import { createApiClient } from "./client";

export * from "./client";

/** The client every screen uses, bound to the build's validated API origin. */
export const api = createApiClient(__VITRINA_API_ORIGIN__);
