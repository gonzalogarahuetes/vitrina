export class ErrorEnvelope extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: object,
  ) {
    super(message);
  }
}
