import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { InMemoryWebStorage, User } from 'oidc-client-ts'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { OidcConfig } from './config'
import { resolveAuthConfig } from './config'
import { createRuntimeAuthSession } from './factory'
import {
  OIDC_TRANSACTION_PREFIX,
  OidcAuthSession,
  createOidcUserManager,
  type OidcManagerLike,
} from './oidcSession'

const timestamp = '2026-07-14T05:00:00.000Z'

function jsonResponse(data: unknown, status = 200): Response {
  return {
    json: async () => data,
    ok: status >= 200 && status < 300,
    status,
  } as Response
}

function emptyOverview() {
  return {
    summary: {
      organizationId: 'org_alpha',
      generatedAt: timestamp,
      period: { from: timestamp, to: '2026-07-15T05:00:00.000Z' },
      preset: 'today',
      calls: {},
      leads: {},
      comparisons: {},
    },
    metrics: {
      totalCalls: 0,
      totalTalkDurationSeconds: 0,
      connectedCalls: 0,
      missedCalls: 0,
      uniqueClients: 0,
      workingHoursSeconds: 0,
    },
    hourlyActivity: [],
    outcomes: [],
    attention: [],
    teamPerformance: [],
    recentActivity: [],
  }
}

function oidcConfig(): OidcConfig {
  return {
    authority: 'https://identity.example.test',
    clientId: 'callora-web',
    redirectUri: `${window.location.origin}/auth/callback`,
    postLogoutRedirectUri: `${window.location.origin}/auth/logout-callback`,
    scope: 'openid profile email callora-api',
  }
}

function oidcUser(returnUrl = '/', expiresInSeconds = 3600): User {
  const now = Math.floor(Date.now() / 1000)
  return new User({
    access_token: 'oidc-access-token-secret',
    token_type: 'Bearer',
    expires_at: (Date.now() / 1000) + expiresInSeconds,
    userState: { v: 1, returnUrl },
    profile: {
      sub: 'oidc-user',
      iss: 'https://identity.example.test',
      aud: 'callora-web',
      exp: now + 3600,
      iat: now,
      name: 'OIDC User',
      email: 'user@example.test',
    },
  })
}

function fakeManager(overrides: Partial<OidcManagerLike> = {}): OidcManagerLike {
  return {
    getUser: vi.fn(async () => null),
    removeUser: vi.fn(async () => undefined),
    signinRedirect: vi.fn(async () => undefined),
    signinRedirectCallback: vi.fn(async () => { throw new Error('No callback configured') }),
    signoutRedirect: vi.fn(async () => undefined),
    signoutRedirectCallback: vi.fn(async () => ({} as never)),
    ...overrides,
  } as OidcManagerLike
}

function successfulApiFetch() {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/v1/dashboard/overview')) return jsonResponse({ ok: true, data: emptyOverview() })
    if (url.includes('/v1/employees')) {
      return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
    }
    return jsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  })
}

function storageText(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)
    return key ? `${key}:${storage.getItem(key)}` : ''
  }).join('\n')
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: new InMemoryWebStorage() })
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new InMemoryWebStorage() })
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.stubEnv('VITE_API_URL', 'http://localhost:4100')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Unexpected network request')))
})

afterEach(() => {
  window.history.replaceState({}, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Callora authentication', () => {
  it('keeps development mode as the default runtime', () => {
    expect(resolveAuthConfig({}, window.location.origin)).toEqual({ mode: 'dev' })
    expect(createRuntimeAuthSession({}, window.location.origin).mode).toBe('dev')
    expect(resolveAuthConfig({}, 'https://app.example.test', true)).toEqual({
      mode: 'invalid',
      error: 'Production requires VITE_AUTH_MODE=oidc or builtin.',
    })
    expect(resolveAuthConfig({ VITE_AUTH_MODE: 'dev' }, 'https://app.example.test', true).mode).toBe('invalid')
  })

  it('shows signed-out UI and starts a versioned OIDC redirect', async () => {
    const manager = fakeManager()
    const session = new OidcAuthSession(oidcConfig(), manager)

    render(<App authSession={session} />)

    expect(await screen.findByRole('heading', { name: 'Sign in to Callora' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Team calling overview' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(manager.signinRedirect).toHaveBeenCalledTimes(1))
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { v: 1, returnUrl: '/' } })
    expect(screen.getByRole('heading', { name: 'Redirecting to sign in' })).toBeInTheDocument()
    expect(storageText(window.localStorage)).not.toContain('token')
    expect(storageText(window.sessionStorage)).not.toContain('token')
  })

  it('processes a validated callback and uses its memory-only bearer token for API calls', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=test-code&state=test-state')
    const user = oidcUser('/reports?source=oidc')
    const manager = fakeManager({ signinRedirectCallback: vi.fn(async () => user) })
    const fetchMock = successfulApiFetch()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <StrictMode>
        <App authSession={new OidcAuthSession(oidcConfig(), manager)} />
      </StrictMode>,
    )

    expect(await screen.findByRole('status', { name: 'Data source: Live data' })).toBeInTheDocument()
    expect(manager.signinRedirectCallback).toHaveBeenCalledWith(
      `${window.location.origin}/auth/callback?code=test-code&state=test-state`,
    )
    expect(manager.signinRedirectCallback).toHaveBeenCalledTimes(1)
    expect(window.location.pathname).toBe('/reports')
    expect(window.location.search).toBe('?source=oidc')
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/dev/session'))).toBe(false)
    const protectedCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/dashboard/overview'))
    expect((protectedCall?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer oidc-access-token-secret')
    expect(storageText(window.localStorage)).not.toContain('oidc-access-token-secret')
    expect(storageText(window.sessionStorage)).not.toContain('oidc-access-token-secret')
  })

  it('clears the in-memory user and starts provider logout', async () => {
    const user = oidcUser()
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    vi.stubGlobal('fetch', successfulApiFetch())

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    await screen.findByRole('status', { name: 'Data source: Live data' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out OIDC User' }))

    expect(await screen.findByRole('heading', { name: 'Sign in to Callora' })).toBeInTheDocument()
    expect(manager.signoutRedirect).toHaveBeenCalledWith({
      post_logout_redirect_uri: `${window.location.origin}/auth/logout-callback`,
      state: { v: 1 },
    })
    expect(manager.removeUser).toHaveBeenCalled()
  })

  it('fails closed with clear UI for incomplete production configuration', async () => {
    const session = createRuntimeAuthSession({
      VITE_AUTH_MODE: 'oidc',
      VITE_OIDC_AUTHORITY: 'https://identity.example.test',
    }, window.location.origin)

    render(<App authSession={session} />)

    expect(await screen.findByRole('heading', { name: 'Authentication unavailable' })).toBeInTheDocument()
    expect(screen.getByText(/OIDC configuration is incomplete/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start a new sign-in' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Team calling overview' })).not.toBeInTheDocument()
  })

  it('rejects unsafe OIDC URLs and a missing explicit OIDC API URL', async () => {
    const unsafeAuthority = resolveAuthConfig({
      VITE_AUTH_MODE: 'oidc',
      VITE_OIDC_AUTHORITY: 'https://user:password@identity.example.test?tenant=secret',
      VITE_OIDC_CLIENT_ID: 'callora-web',
      VITE_OIDC_REDIRECT_URI: `${window.location.origin}/auth/callback`,
    }, window.location.origin)
    expect(unsafeAuthority.mode).toBe('invalid')

    const crossOriginRedirect = resolveAuthConfig({
      VITE_AUTH_MODE: 'oidc',
      VITE_OIDC_AUTHORITY: 'https://identity.example.test',
      VITE_OIDC_CLIENT_ID: 'callora-web',
      VITE_OIDC_REDIRECT_URI: 'https://attacker.example.test/auth/callback',
    }, window.location.origin)
    expect(crossOriginRedirect.mode).toBe('invalid')

    const session = createRuntimeAuthSession({
      VITE_AUTH_MODE: 'oidc',
      VITE_OIDC_AUTHORITY: 'https://identity.example.test',
      VITE_OIDC_CLIENT_ID: 'callora-web',
      VITE_OIDC_REDIRECT_URI: `${window.location.origin}/auth/callback`,
    }, window.location.origin, false)
    render(<App authSession={session} />)

    expect(await screen.findByText(/VITE_API_URL is required/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Team calling overview' })).not.toBeInTheDocument()
  })

  it('rejects malformed and mismatched callback state without exposing provider details', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=test-code')
    const missingStateManager = fakeManager()
    const firstRender = render(<App authSession={new OidcAuthSession(oidcConfig(), missingStateManager)} />)

    expect(await screen.findByText(/callback is missing its state value/)).toBeInTheDocument()
    expect(missingStateManager.signinRedirectCallback).not.toHaveBeenCalled()
    firstRender.unmount()

    window.history.replaceState({}, '', '/auth/callback?code=private-code&state=wrong-state')
    const mismatchManager = fakeManager({
      signinRedirectCallback: vi.fn(async () => { throw new Error('No matching state: private-code') }),
    })
    render(<App authSession={new OidcAuthSession(oidcConfig(), mismatchManager)} />)

    expect(await screen.findByText(/callback could not be validated/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('private-code')
  })

  it('classifies only exact callback locations and does not clear an invalid logout response', async () => {
    window.history.replaceState({}, '', '/unexpected?code=test-code&state=test-state')
    const unexpectedManager = fakeManager()
    const firstRender = render(<App authSession={new OidcAuthSession(oidcConfig(), unexpectedManager)} />)

    expect(await screen.findByText(/unexpected callback URL/)).toBeInTheDocument()
    expect(unexpectedManager.signinRedirectCallback).not.toHaveBeenCalled()
    firstRender.unmount()

    window.history.replaceState({}, '', '/auth/logout-callback?error=access_denied&state=invalid-state')
    const invalidLogoutManager = fakeManager({
      signoutRedirectCallback: vi.fn(async () => { throw new Error('No matching signout state') }),
    })
    render(<App authSession={new OidcAuthSession(oidcConfig(), invalidLogoutManager)} />)

    expect(await screen.findByText(/sign-out callback could not be validated/)).toBeInTheDocument()
    expect(invalidLogoutManager.signinRedirectCallback).not.toHaveBeenCalled()
    expect(invalidLogoutManager.removeUser).not.toHaveBeenCalled()
  })

  it('keeps user tokens in memory while versioning minimal transaction storage', async () => {
    const manager = createOidcUserManager(oidcConfig(), window.sessionStorage)
    await manager.settings.userStore.set('probe', oidcUser().toStorageString())

    expect(storageText(window.localStorage)).not.toContain('oidc-access-token-secret')
    expect(storageText(window.sessionStorage)).not.toContain('oidc-access-token-secret')

    const minimalState = JSON.stringify({ v: 1, returnUrl: '/reports' })
    await manager.settings.stateStore.set('probe-state', minimalState)
    expect(window.sessionStorage.getItem(`${OIDC_TRANSACTION_PREFIX}probe-state`)).toBe(minimalState)
    expect(storageText(window.sessionStorage)).not.toContain('access_token')
  })

  it('fails closed instead of rendering demo data when an OIDC token is rejected', async () => {
    const user = oidcUser()
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/dashboard/overview')) {
        return jsonResponse({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401)
      }
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    expect(await screen.findByRole('heading', { name: 'Authentication unavailable' })).toBeInTheDocument()
    expect(screen.getByText(/session expired or is no longer authorized/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Data source: Demo data · API unavailable' })).not.toBeInTheDocument()
    expect(screen.queryByText('Amit Patel')).not.toBeInTheDocument()
    await waitFor(() => expect(manager.removeUser).toHaveBeenCalled())
  })

  it('shows an explicit access-denied gate for OIDC 403 without treating it as demo data', async () => {
    const user = oidcUser()
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/dashboard/overview')) {
        return jsonResponse({ ok: false, error: { code: 'FORBIDDEN', message: 'Denied' } }, 403)
      }
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    }))

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    expect(await screen.findByText(/does not have permission to access this Callora workspace/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Data source: Demo data · API unavailable' })).not.toBeInTheDocument()
    expect(manager.removeUser).not.toHaveBeenCalled()
  })

  it('never falls back to demo workspace data for OIDC service failures', async () => {
    const user = oidcUser()
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/dashboard/overview')) {
        return jsonResponse({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Offline' } }, 503)
      }
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    }))

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    expect(await screen.findByText(/Demo data is disabled in OIDC mode/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Data source: Demo data · API unavailable' })).not.toBeInTheDocument()
    expect(screen.queryByText('Amit Patel')).not.toBeInTheDocument()
  })

  it('never creates a local employee draft while OIDC data is still loading', async () => {
    const user = oidcUser()
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => (
      new Promise<Response>(() => undefined)
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    expect(await screen.findByRole('status', { name: 'Data source: Loading live data' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Private Loading Agent' } })
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '+91 98765 33333' } })
    fireEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)

    expect(await screen.findByText(/No employee data was saved/)).toBeInTheDocument()
    expect(screen.queryByText('Local draft · not synced')).not.toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /Private Loading Agent/ })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('proactively clears an OIDC session when its access token expires', async () => {
    const user = oidcUser('/', 0.05)
    const manager = fakeManager({ getUser: vi.fn(async () => user) })
    vi.stubGlobal('fetch', successfulApiFetch())

    render(<App authSession={new OidcAuthSession(oidcConfig(), manager)} />)

    expect(await screen.findByText(/session expired or is no longer authorized/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Team calling overview' })).not.toBeInTheDocument()
    await waitFor(() => expect(manager.removeUser).toHaveBeenCalled())
  })
})
