import type { AuthEnvironment } from './config'
import { resolveAuthConfig } from './config'
import { resolveApiBaseUrl } from '../api/client'
import { DevAuthSession } from './devSession'
import { OidcAuthSession } from './oidcSession'
import { BuiltinAuthSession } from './builtinSession'
import type { AuthSession } from './types'

class InvalidAuthSession implements AuthSession {
  readonly mode = 'oidc' as const
  readonly canSignIn = false

  constructor(private readonly configError: string) {}

  async initialize(): Promise<never> {
    throw new Error(this.configError)
  }

  async getAccessToken(): Promise<null> {
    return null
  }

  async signIn(): Promise<never> {
    throw new Error(this.configError)
  }

  async signOut(): Promise<void> {}

  async clear(): Promise<void> {}
}

export function createRuntimeAuthSession(
  environment: AuthEnvironment = import.meta.env,
  currentOrigin = window.location.origin,
  isProduction = import.meta.env.PROD,
): AuthSession {
  const config = resolveAuthConfig(environment, currentOrigin, isProduction)
  if (config.mode === 'dev') return new DevAuthSession()
  if (config.mode === 'builtin') return new BuiltinAuthSession()
  if (config.mode === 'invalid') return new InvalidAuthSession(config.error)
  try {
    resolveApiBaseUrl(environment.VITE_API_URL, {
      authMode: 'oidc',
      currentOrigin,
      isProduction,
    })
    return new OidcAuthSession(config.oidc)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Secure OIDC configuration is unavailable.'
    return new InvalidAuthSession(message)
  }
}
