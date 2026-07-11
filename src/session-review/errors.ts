export type SessionReviewErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_ACCESS_DENIED"
  | "SESSION_EMPTY"
  | "SDK_FAILURE";

export class SessionReviewError extends Error {
  constructor(
    public readonly code: SessionReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionReviewError";
  }
}
