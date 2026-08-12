export class ErrorEnvelope extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: object,
  ) {
    super(message);
  }
}

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  ALBUM_REVOKED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
};

export function errorEnvelope(error: any, request: any, reply: any) {
  if (error instanceof ErrorEnvelope) {
    return reply
      .code(STATUS[error.code] ?? 400)
      .send({ code: error.code, message: error.message }); // message is static English, #25
  }
  if (error.validation) {
    // Fastify schema failure
    return reply.code(400).send({ code: "VALIDATION_FAILED" }); // NB: see below
  }
  request.log.error(error); // full detail to the log, never the wire
  return reply.code(500).send({ code: "INTERNAL" }); // opaque; no message, no detail
}
