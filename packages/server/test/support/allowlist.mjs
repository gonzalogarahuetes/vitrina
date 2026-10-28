/**
 * For test graphs whose subject is not the signup allowlist but which sign up
 * owners under addresses made up on the fly. It admits every address, so it
 * must never stand in for the list in the allowlist's own tests
 * (signup.test.mjs, credential-routes.test.mjs, config.test.mjs).
 */
export const EVERYONE_INVITED = Object.freeze({ has: () => true });
