export interface OidcConfig {
  authority: string
  clientId: string
  redirectUri: string
  postLogoutRedirectUri: string
  scope: string
}

export interface AuthEnvironment {
  VITE_API_URL?: string
  VITE_AUTH_MODE?: string
  VITE_OIDC_AUTHORITY?: string
  VITE_OIDC_CLIENT_ID?: string
  VITE_OIDC_REDIRECT_URI?: string
  VITE_OIDC_POST_LOGOUT_REDIRECT_URI?: string
  VITE_OIDC_SCOPE?: string
}

export type ResolvedAuthConfig =
  | { mode: 'dev' }
  | { mode: 'builtin' }
  | { mode: 'oidc'; oidc: OidcConfig }
  | { mode: 'invalid'; error: string }

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result ? result : undefined
}

function parseAbsoluteUrl(value: string, field: string): URL | string {
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return `${field} must use http or https.`
    return parsed
  } catch {
    return `${field} must be an absolute URL.`
  }
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname)
}

function hasUnsafeUrlParts(url: URL): boolean {
  return Boolean(url.username || url.password || url.search || url.hash)
}

function isSecureAuthority(url: URL, currentOrigin: string): boolean {
  if (url.protocol === 'https:') return true
  const applicationUrl = new URL(currentOrigin)
  return isLocalHostname(applicationUrl.hostname) && isLocalHostname(url.hostname)
}

export function resolveAuthConfig(
  environment: AuthEnvironment = import.meta.env,
  currentOrigin = window.location.origin,
  isProduction = import.meta.env.PROD,
): ResolvedAuthConfig {
  const requestedMode = trimmed(environment.VITE_AUTH_MODE)?.toLowerCase()
  const hasOidcSetting = Boolean(
    trimmed(environment.VITE_OIDC_AUTHORITY)
    || trimmed(environment.VITE_OIDC_CLIENT_ID)
    || trimmed(environment.VITE_OIDC_REDIRECT_URI),
  )
  const mode = requestedMode ?? (hasOidcSetting ? 'oidc' : 'dev')

  if (isProduction && mode !== 'oidc' && mode !== 'builtin') {
    return { mode: 'invalid', error: 'Production requires VITE_AUTH_MODE=oidc or builtin.' }
  }
  if (mode === 'dev') return { mode: 'dev' }
  if (mode === 'builtin') return { mode: 'builtin' }
  if (mode !== 'oidc') {
    return { mode: 'invalid', error: 'VITE_AUTH_MODE must be dev, builtin, or oidc.' }
  }

  const authority = trimmed(environment.VITE_OIDC_AUTHORITY)
  const clientId = trimmed(environment.VITE_OIDC_CLIENT_ID)
  const redirectUri = trimmed(environment.VITE_OIDC_REDIRECT_URI)
  const missing = [
    authority ? null : 'VITE_OIDC_AUTHORITY',
    clientId ? null : 'VITE_OIDC_CLIENT_ID',
    redirectUri ? null : 'VITE_OIDC_REDIRECT_URI',
  ].filter((field): field is string => field !== null)
  if (missing.length > 0 || !authority || !clientId || !redirectUri) {
    return { mode: 'invalid', error: `OIDC configuration is incomplete: ${missing.join(', ')} required.` }
  }

  const parsedAuthority = parseAbsoluteUrl(authority, 'VITE_OIDC_AUTHORITY')
  if (typeof parsedAuthority === 'string') return { mode: 'invalid', error: parsedAuthority }
  if (hasUnsafeUrlParts(parsedAuthority)) {
    return { mode: 'invalid', error: 'VITE_OIDC_AUTHORITY cannot contain credentials, query parameters, or a fragment.' }
  }
  if (!isSecureAuthority(parsedAuthority, currentOrigin)) {
    return { mode: 'invalid', error: 'VITE_OIDC_AUTHORITY must use HTTPS outside localhost.' }
  }

  const parsedRedirect = parseAbsoluteUrl(redirectUri, 'VITE_OIDC_REDIRECT_URI')
  if (typeof parsedRedirect === 'string') return { mode: 'invalid', error: parsedRedirect }
  if (hasUnsafeUrlParts(parsedRedirect)) {
    return { mode: 'invalid', error: 'VITE_OIDC_REDIRECT_URI cannot contain credentials, query parameters, or a fragment.' }
  }
  if (parsedRedirect.origin !== currentOrigin) {
    return { mode: 'invalid', error: 'VITE_OIDC_REDIRECT_URI must use the same origin as this application.' }
  }

  const postLogoutRedirectUri = trimmed(environment.VITE_OIDC_POST_LOGOUT_REDIRECT_URI) ?? `${currentOrigin}/`
  const parsedPostLogout = parseAbsoluteUrl(postLogoutRedirectUri, 'VITE_OIDC_POST_LOGOUT_REDIRECT_URI')
  if (typeof parsedPostLogout === 'string') return { mode: 'invalid', error: parsedPostLogout }
  if (hasUnsafeUrlParts(parsedPostLogout)) {
    return { mode: 'invalid', error: 'VITE_OIDC_POST_LOGOUT_REDIRECT_URI cannot contain credentials, query parameters, or a fragment.' }
  }
  if (parsedPostLogout.origin !== currentOrigin) {
    return { mode: 'invalid', error: 'VITE_OIDC_POST_LOGOUT_REDIRECT_URI must use the same origin as this application.' }
  }

  const scope = trimmed(environment.VITE_OIDC_SCOPE) ?? 'openid profile email'
  if (!scope.split(/\s+/).includes('openid')) {
    return { mode: 'invalid', error: 'VITE_OIDC_SCOPE must include the openid scope.' }
  }

  return {
    mode: 'oidc',
    oidc: {
      authority: parsedAuthority.toString().replace(/\/$/, ''),
      clientId,
      redirectUri: parsedRedirect.toString(),
      postLogoutRedirectUri: parsedPostLogout.toString(),
      scope,
    },
  }
}

export function safeReturnUrl(value: string, currentOrigin = window.location.origin): string {
  try {
    const parsed = new URL(value, currentOrigin)
    if (parsed.origin !== currentOrigin) return '/'
    const hasCallbackParameters = parsed.searchParams.has('code')
      || parsed.searchParams.has('error')
      || parsed.searchParams.has('state')
    return hasCallbackParameters ? '/' : `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}
