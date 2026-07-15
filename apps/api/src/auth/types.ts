import type { OrganizationId } from "@callora/contracts";

/**
 * Identity claims that are safe to use for authorization decisions.
 *
 * Implementations must only return this value after signature, issuer,
 * audience, time, and required-claim validation has succeeded.
 */
export interface TrustedOidcIdentity {
  subject: string;
  organizationId: OrganizationId;
  issuer: string;
}

/** Provider-neutral bearer-token boundary used by the HTTP authentication hook. */
export interface OidcBearerVerifier {
  verify(token: string): Promise<TrustedOidcIdentity>;
}
