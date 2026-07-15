import { describe, expect, it, vi } from 'vitest'
import { CalloraApiClient, MAX_EMPLOYEE_PAGES, resolveApiBaseUrl } from './client'

function jsonResponse(data: unknown, status = 200): Response {
  return {
    json: async () => data,
    ok: status >= 200 && status < 300,
    status,
  } as Response
}

function employee(id: string) {
  return {
    id,
    organizationId: 'org_alpha',
    displayName: `Employee ${id}`,
    status: 'active',
    deviceIds: [],
    createdAt: '2026-07-14T05:00:00.000Z',
    updatedAt: '2026-07-14T05:00:00.000Z',
  }
}

describe('CalloraApiClient employee pagination', () => {
  it('follows signed cursors and combines all employee pages', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.searchParams.get('cursor') === 'page-2') {
        return jsonResponse({ ok: true, data: {
          items: [employee('emp-2')],
          cursorInfo: { hasMore: false },
        } })
      }
      return jsonResponse({ ok: true, data: {
        items: [employee('emp-1')],
        cursorInfo: { hasMore: true, nextCursor: 'page-2' },
      } })
    })
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    const result = await client.getEmployees('token')

    expect(result.items.map((item) => item.id)).toEqual(['emp-1', 'emp-2'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1][0])).toContain('cursor=page-2')
  })

  it('rejects cursor loops instead of repeatedly fetching the same page', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {
      items: [],
      cursorInfo: { hasMore: true, nextCursor: 'same-cursor' },
    } }))
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    await expect(client.getEmployees('token')).rejects.toThrow('invalid cursor')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stops at the employee-page safety bound', async () => {
    let page = 0
    const fetcher = vi.fn(async () => {
      page += 1
      return jsonResponse({ ok: true, data: {
        items: [],
        cursorInfo: { hasMore: true, nextCursor: `cursor-${page}` },
      } })
    })
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    await expect(client.getEmployees('token')).rejects.toThrow(`${MAX_EMPLOYEE_PAGES}-page safety limit`)
    expect(fetcher).toHaveBeenCalledTimes(MAX_EMPLOYEE_PAGES)
  })
})

describe('CalloraApiClient transport security', () => {
  it('requires and validates an explicit secure API URL for OIDC/production', () => {
    expect(() => resolveApiBaseUrl(undefined, {
      authMode: 'oidc',
      currentOrigin: 'https://app.example.test',
      isProduction: true,
    })).toThrow('VITE_API_URL is required')
    expect(() => resolveApiBaseUrl('http://api.example.test', {
      authMode: 'oidc',
      currentOrigin: 'https://app.example.test',
      isProduction: true,
    })).toThrow('must use HTTPS')
    expect(() => resolveApiBaseUrl('https://user:pass@api.example.test?token=secret#value', {
      authMode: 'oidc',
      currentOrigin: 'https://app.example.test',
      isProduction: true,
    })).toThrow('cannot contain credentials')
    expect(resolveApiBaseUrl('http://localhost:4100', {
      authMode: 'oidc',
      currentOrigin: 'http://localhost:4173',
      isProduction: false,
    })).toBe('http://localhost:4100')
  })

  it('omits ambient cookies from bearer-authenticated API requests', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {
      items: [],
      cursorInfo: { hasMore: false },
    } }))
    const client = new CalloraApiClient({
      authMode: 'oidc',
      baseUrl: 'https://api.example.test',
      currentOrigin: 'https://app.example.test',
      fetcher: fetcher as typeof fetch,
      isProduction: true,
    })

    await client.getEmployees('memory-bearer-token')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.credentials).toBe('omit')
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get('Authorization')).toBe('Bearer memory-bearer-token')
  })

  it('binds administrator device recovery to one UUID idempotency key', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {
      deviceId: 'device/one',
      employeeId: 'employee-1',
      revokedAt: '2026-07-15T08:00:00.000Z',
      reason: 'Credential was lost during a managed phone replacement.',
      revokedCredentialCount: 1,
      consentWithdrawn: true,
    } }))
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })
    const requestId = '8c6820bb-c7f4-4f8f-8ee6-2e9e0ad21da6'

    await client.revokeDevice('device/one', {
      requestId,
      reason: 'Credential was lost during a managed phone replacement.',
    }, 'memory-bearer-token')

    expect(String(fetcher.mock.calls[0][0]).endsWith('/v1/devices/device%2Fone/revoke')).toBe(true)
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get('Idempotency-Key')).toBe(requestId)
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      requestId,
      reason: 'Credential was lost during a managed phone replacement.',
    })
  })
})
