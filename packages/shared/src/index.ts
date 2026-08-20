export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "ACCESS_REVOKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "INTERNAL";

/** The wire shape. One envelope, every error, no exceptions. */
export type ErrorBody = {
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, string>>;
};
