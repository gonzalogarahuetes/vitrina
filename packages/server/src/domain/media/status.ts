/*
 * Non-negotiable #9's ladder — api-sketch §9.7, schema §3.
 * Who moves a row along it is §9.7's table; the repository port names one
 * method per legal edge, so an illegal transition is inexpressible.
 */
export type MediaStatus = "pending" | "processing" | "ready" | "failed";

/** Schema §3 admits both from day one (#8); §9.6's API enum is `photo` alone. */
export type MediaKind = "photo" | "video";
