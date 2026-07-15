export type OidcVerificationFailure =
  | "invalid_token"
  | "invalid_subject"
  | "invalid_organization"
  | "invalid_issuer"
  | "disallowed_algorithm";

/**
 * Stable error boundary for callers. The public message deliberately avoids
 * exposing jose parsing/signature details, while `cause` remains available to
 * structured server logs.
 */
export class OidcBearerVerificationError extends Error {
  readonly reason: OidcVerificationFailure;

  constructor(reason: OidcVerificationFailure, options?: { cause?: unknown }) {
    super("The bearer token could not be verified", options);
    this.name = "OidcBearerVerificationError";
    this.reason = reason;
  }
}
