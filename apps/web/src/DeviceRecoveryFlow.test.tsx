import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function jsonResponse(data: unknown, status = 200): Response {
  return {
    json: async () => data,
    ok: status >= 200 && status < 300,
    status,
  } as Response
}

const timestamp = '2026-07-15T08:00:00.000Z'

function overview() {
  return {
    summary: {
      organizationId: 'org_alpha',
      generatedAt: timestamp,
      period: { from: timestamp, to: '2026-07-16T08:00:00.000Z' },
      preset: 'today',
      calls: {},
      leads: {},
      comparisons: {},
    },
    metrics: {},
    hourlyActivity: [],
    outcomes: [],
    attention: [],
    teamPerformance: [],
    recentActivity: [],
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://localhost:4100')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('administrator stranded-device recovery flow', () => {
  it('discovers devices.manage and submits an audited exact-device recovery request', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/dev/session')) {
        return jsonResponse({ ok: true, data: {
          accessToken: 'owner-token',
          tokenType: 'Bearer',
          expiresAt: '2026-07-16T08:00:00.000Z',
          actor: {
            userId: 'owner-1',
            displayName: 'Owner',
            email: 'owner@example.test',
            organizationId: 'org_alpha',
            organizationName: 'Alpha',
            role: 'owner',
            permissions: ['employees.read', 'devices.manage'],
          },
        } })
      }
      if (url.endsWith('/v1/session')) {
        return jsonResponse({ ok: true, data: {
          userId: 'owner-1',
          displayName: 'Owner',
          email: 'owner@example.test',
          organizationId: 'org_alpha',
          organizationName: 'Alpha',
          role: 'owner',
          permissions: ['employees.read', 'devices.manage'],
        } })
      }
      if (url.includes('/v1/dashboard/overview')) return jsonResponse({ ok: true, data: overview() })
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: {
          items: [{
            id: 'employee-1',
            organizationId: 'org_alpha',
            displayName: 'Kiran Shah',
            status: 'active',
            deviceIds: ['device-1'],
            createdAt: timestamp,
            updatedAt: timestamp,
          }],
          cursorInfo: { hasMore: false },
        } })
      }
      if (url.endsWith('/v1/devices/device-1/revoke') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { requestId: string; reason: string }
        return jsonResponse({ ok: true, data: {
          deviceId: 'device-1',
          employeeId: 'employee-1',
          revokedAt: timestamp,
          reason: body.reason,
          revokedCredentialCount: 1,
          consentWithdrawn: true,
        } })
      }
      return jsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByRole('status', { name: 'Data source: Live data' })
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Kiran Shah' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke a stranded device' }))
    const dialog = screen.getByRole('dialog', { name: 'Revoke Kiran Shah’s device' })
    fireEvent.change(within(dialog).getByLabelText('Operational reason'), {
      target: { value: 'Credential was lost during a managed phone replacement.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke device' }))

    expect(await screen.findByText('Device revoked, credentials disabled, and consent withdrawn')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More actions for Kiran Shah' })).not.toBeInTheDocument()
    const revokeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/devices/device-1/revoke'))
    expect(revokeCall).toBeDefined()
    const body = JSON.parse(String(revokeCall?.[1]?.body)) as { requestId: string; reason: string }
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect((revokeCall?.[1]?.headers as Headers).get('Idempotency-Key')).toBe(body.requestId)
    expect(body.reason).toBe('Credential was lost during a managed phone replacement.')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/session'))).toBe(true))
  })
})
