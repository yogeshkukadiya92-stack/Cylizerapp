export type AuthMode = 'dev' | 'oidc' | 'builtin'

export interface AuthUserSummary {
  subject: string
  displayName: string
  email?: string
  expiresAt?: number
}

export type AuthInitialization =
  | { status: 'signed_in'; user: AuthUserSummary }
  | { status: 'signed_out'; user: null }

export type AuthUiState =
  | { status: 'checking'; user: null; error: null }
  | { status: 'redirecting'; user: null; error: null }
  | { status: 'signing_out'; user: AuthUserSummary; error: null }
  | { status: 'signed_in'; user: AuthUserSummary; error: null }
  | { status: 'signed_out'; user: null; error: null }
  | { status: 'error'; user: null; error: string }

export interface AuthSession {
  readonly mode: AuthMode
  readonly canSignIn: boolean
  readonly synchronousInitialization?: AuthInitialization
  initialize(): Promise<AuthInitialization>
  getAccessToken(signal?: AbortSignal): Promise<string | null>
  signIn(returnUrl: string): Promise<void>
  signOut(): Promise<void>
  clear(): Promise<void>
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Authentication is required before loading live data.')
    this.name = 'AuthenticationRequiredError'
  }
}
