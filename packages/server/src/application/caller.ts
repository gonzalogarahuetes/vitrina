/*
 * The resolved identity — api-sketch §7.1. Constructed only after §7.3's
 * steps 3 and 4 have run, so a handler holding one has no revocation flag it
 * could forget to check.
 */
export type Caller =
  | { readonly kind: "owner"; readonly ownerId: string }
  | {
      readonly kind: "recipient";
      readonly recipientId: string;
      readonly albumId: string;
    };
