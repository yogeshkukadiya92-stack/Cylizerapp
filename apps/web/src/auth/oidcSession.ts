import {
  InMemoryWebStorage,
  UserManager,
  WebStorageStateStore,
  type User,
} from 'oidc-client-ts'
import type { OidcConfig } from './config'
import { safeReturnUrl } from './config'
import type { AuthInitialization, AuthSession, AuthUserSummary } from './types'

export const OIDC_TRANSACTION_PREFIX = 'callora.oidc.tx.v1.'
const OIDC_USER_MEMORY_PREFIX = 'callora.oidc.user.v1.'
const APP_STATE_VERSION = 1

interface OidcApplicationState {
  v: typeof APP_STATE_VERSION
  returnUrl: string
}

export type OidcManagerLike = Pick<
  UserManager,
  | 'getUser'
  | 'removeUser'
  | 'signinRedirect'
  | 'signinRedirectCallback'
  | 'signoutRedirect'
  | 'signoutRedirectCallback'
>

export interface AuthNavigation {
  currentUrl(): string
  replace(relativeUrl: string): void
}

const browserNavigation: AuthNavigation = {
  currentUrl: () => window.location.href,
  replace: (relativeUrl) => window.history.replaceState({}, document.title, relativeUrl),
}

function callbackError(message: string): Error {
  const error = new Error(message)
  error.name = 'OidcCallbackError'
  return error
}

function isApplicationState(value: unknown): value is OidcApplicationState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OidcApplicationState>
  return candidate.v === APP_STATE_VERSION && typeof candidate.returnUrl === 'string'
}

function userSummary(user: User): AuthUserSummary {
  const displayName = [user.profile.name, user.profile.preferred_username, user.profile.email, user.profile.sub]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? 'Callora user'
  return {
    subject: user.profile.sub,
    displayName,
    email: typeof user.profile.email === 'string' ? user.profile.email : undefined,
    expiresAt: user.expires_at,
  }
}

function isUsableUser(user: User | null): user is User {
  return Boolean(user && user.expired !== true && user.access_token.trim())
}

function sameCallbackLocation(current: URL, expected: string): boolean {
  const callback = new URL(expected)
  return current.origin === callback.origin
    && current.pathname === callback.pathname
    && current.hash === ''
    && callback.search === ''
    && callback.hash === ''
}

export function createOidcUserManager(
  config: OidcConfig,
  transactionStorage: Storage = window.sessionStorage,
): UserManager {
  return new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: 'code',
    scope: config.scope,
    automaticSilentRenew: false,
    disablePKCE: false,
    loadUserInfo: false,
    monitorSession: false,
    staleStateAgeInSeconds: 600,
    stateStore: new WebStorageStateStore({
      prefix: OIDC_TRANSACTION_PREFIX,
      store: transactionStorage,
    }),
    userStore: new WebStorageStateStore({
      prefix: OIDC_USER_MEMORY_PREFIX,
      store: new InMemoryWebStorage(),
    }),
  })
}

export class OidcAuthSession implements AuthSession {
  readonly mode = 'oidc' as const
  readonly canSignIn = true
  private currentUser: User | null = null
  private initializationPromise: Promise<AuthInitialization> | null = null

  constructor(
    private readonly config: OidcConfig,
    private readonly manager: OidcManagerLike = createOidcUserManager(config),
    private readonly navigation: AuthNavigation = browserNavigation,
  ) {}

  initialize(): Promise<AuthInitialization> {
    this.initializationPromise ??= this.initializeOnce()
    return this.initializationPromise
  }

  private async initializeOnce(): Promise<AuthInitialization> {
    const currentUrl = new URL(this.navigation.currentUrl())
    const isSignoutResponse = sameCallbackLocation(currentUrl, this.config.postLogoutRedirectUri)
      && (currentUrl.searchParams.has('state') || currentUrl.searchParams.has('error'))

    if (isSignoutResponse) {
      try {
        await this.manager.signoutRedirectCallback(currentUrl.toString())
      } catch {
        throw callbackError('The sign-out callback could not be validated. Start a new sign-in or try signing out again.')
      }
      await this.manager.removeUser()
      this.currentUser = null
      this.navigation.replace('/')
      return { status: 'signed_out', user: null }
    }

    const isSigninResponse = currentUrl.searchParams.has('code') || currentUrl.searchParams.has('error')

    if (isSigninResponse) {
      if (!sameCallbackLocation(currentUrl, this.config.redirectUri)) {
        throw callbackError('The sign-in response arrived on an unexpected callback URL.')
      }
      if (!currentUrl.searchParams.has('state')) {
        throw callbackError('The sign-in callback is missing its state value. Start a new sign-in and try again.')
      }
      try {
        const user = await this.manager.signinRedirectCallback(currentUrl.toString())
        if (!isUsableUser(user) || !isApplicationState(user.state)) {
          throw callbackError('The sign-in callback application state is invalid. Start a new sign-in and try again.')
        }
        this.currentUser = user
        this.navigation.replace(safeReturnUrl(user.state.returnUrl, currentUrl.origin))
        return { status: 'signed_in', user: userSummary(user) }
      } catch (error) {
        if (error instanceof Error && error.name === 'OidcCallbackError') throw error
        throw callbackError('The sign-in callback could not be validated. Start a new sign-in and try again.')
      }
    }

    const user = await this.manager.getUser()
    if (!isUsableUser(user)) {
      if (user) await this.manager.removeUser()
      this.currentUser = null
      return { status: 'signed_out', user: null }
    }
    this.currentUser = user
    return { status: 'signed_in', user: userSummary(user) }
  }

  async getAccessToken(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
    const user = this.currentUser ?? await this.manager.getUser()
    if (!isUsableUser(user)) return null
    this.currentUser = user
    return user.access_token
  }

  async signIn(returnUrl: string): Promise<void> {
    const currentOrigin = new URL(this.navigation.currentUrl()).origin
    await this.manager.signinRedirect({
      state: {
        v: APP_STATE_VERSION,
        returnUrl: safeReturnUrl(returnUrl, currentOrigin),
      } satisfies OidcApplicationState,
    })
  }

  async signOut(): Promise<void> {
    try {
      if (this.currentUser ?? await this.manager.getUser()) {
        await this.manager.signoutRedirect({
          post_logout_redirect_uri: this.config.postLogoutRedirectUri,
          state: { v: APP_STATE_VERSION },
        })
      }
    } finally {
      await this.manager.removeUser()
      this.currentUser = null
    }
  }

  async clear(): Promise<void> {
    await this.manager.removeUser()
    this.currentUser = null
  }
}
