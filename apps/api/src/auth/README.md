# Production OIDC bearer verification

`ProductionOidcBearerVerifier` validates JWT access tokens with `jose` and a
caching remote JWKS resolver. It requires an exact issuer, exact API audience,
an explicit asymmetric signature-algorithm allowlist, an expiry, a subject, and
a dedicated organization claim. It never accepts `none` or symmetric `HS*`
algorithms.

Required configuration:

- `OIDC_ISSUER`: exact HTTPS issuer (`iss`) value.
- `OIDC_AUDIENCE`: exact Callora API audience (`aud`) value.
- `OIDC_JWKS_URI`: provider's HTTPS JWKS endpoint.
- `OIDC_ORGANIZATION_CLAIM`: exact top-level custom claim containing the
  Callora organization ID (for example `org_id` or a namespaced claim URI).

Optional configuration:

- `OIDC_ALLOWED_ALGORITHMS`: comma-separated asymmetric allowlist; defaults to
  `RS256`.
- `OIDC_CLOCK_TOLERANCE_SECONDS`: 0–300 seconds; defaults to 5.

The application should construct this verifier only in production. Tests can
inject a `JwtVerificationBackend`, or the HTTP layer can inject any
`OidcBearerVerifier` fake. A successful verification returns only trusted
`subject`, `organizationId`, and `issuer` values.

The HTTP middleware must then resolve an active organization membership using
all three external identity fields. Do not treat OIDC `sub` as an internal user
ID and do not accept an organization ID from headers, route parameters, or the
request body. The durable repository should expose a method equivalent to:

```ts
resolveActorByExternalIdentity(input: {
  issuer: string;
  subject: string;
  organizationId: string;
}): Promise<ActorContext | undefined>;
```

Return a generic 401 for every verifier failure. Log the stable error reason and
underlying `cause` server-side without logging the bearer token.
