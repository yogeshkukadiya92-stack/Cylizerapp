# Callora web authentication

The web client supports two runtime modes:

- `dev` is the default only in the Vite development runtime. It uses `POST /v1/dev/session` and is intended only for local development.
- `oidc` uses the OpenID Connect Authorization Code flow with PKCE through `oidc-client-ts`.

Production builds fail closed unless `VITE_AUTH_MODE=oidc` and every required OIDC/API value is valid. Setting `VITE_AUTH_MODE=dev` in a production build is rejected.

## Production configuration

Register Callora as a public browser/SPA client. Do not configure or expose a client secret in Vite environment variables.
Vite is configured with `envDir: '../..'`, so place these values in the repository-root `.env` file used by the workspace scripts.

```dotenv
VITE_AUTH_MODE=oidc
VITE_API_URL=https://api.example.com
VITE_OIDC_AUTHORITY=https://identity.example.com
VITE_OIDC_CLIENT_ID=callora-web
VITE_OIDC_REDIRECT_URI=https://app.example.com/auth/callback
VITE_OIDC_POST_LOGOUT_REDIRECT_URI=https://app.example.com/auth/logout-callback
VITE_OIDC_SCOPE=openid profile email callora-api
```

Provider registration must allow the redirect and post-logout URLs exactly as configured. Use the dedicated `/auth/callback` and `/auth/logout-callback` paths on the deployed web origin so callback classification remains exact. The authority must use HTTPS except during localhost development, and the requested scopes must include `openid`.

`VITE_API_URL` is mandatory in OIDC/production mode. It must be an absolute HTTPS URL outside localhost and cannot contain embedded credentials, query parameters, or a fragment. Bearer-authenticated API requests use `credentials: 'omit'` so ambient cookies are never mixed with access-token authentication.

## Browser storage policy

- Access, ID, and refresh tokens use an in-memory user store and are never written to `localStorage` or `sessionStorage` by Callora.
- Temporary PKCE/state records use `sessionStorage` with the versioned prefix `callora.oidc.tx.v1.` and expire as stale after ten minutes.
- Application callback state contains only `{ v, returnUrl }`; the return path is constrained to the current origin.
- A full page reload after login intentionally requires a new authorization redirect because bearer tokens are memory-only.
- Token expiry and API `401` responses clear the memory session and return to a session-expired gate. API `403` responses show an explicit access-denied gate. Other API failures show a live-service error. Demo data is available only in development auth mode.

The OIDC library validates protocol state, PKCE, issuer, signature, audience, nonce, and token response metadata during callback processing. Callora additionally validates the callback URL and its versioned application state before exposing the access token to the API client.
