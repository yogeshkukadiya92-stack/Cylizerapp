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

describe('CalloraApiClient report downloads', () => {
  it('mints and redeems an authenticated one-time report grant', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { token: 'clr_token', expiresAt: '2026-07-17T00:00:00.000Z' } }))
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'Content-Disposition': 'attachment; filename="report.csv"' }), blob: async () => new Blob(['calls\n12']) } as Response)
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })
    const grant = await client.issueReportDownloadToken('job/one', 'access')
    const file = await client.downloadReport('job/one', grant.token, 'access')
    expect(file.fileName).toBe('report.csv')
    expect(String(fetcher.mock.calls[0][0])).toContain('/v1/report-downloads/job%2Fone/token')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ token: 'clr_token' })
    expect((fetcher.mock.calls[1][1]?.headers as Headers).get('Authorization')).toBe('Bearer access')
  })
})

describe('CalloraApiClient lead CRM routes', () => {
  it('encodes lead list filters and uses scoped metadata routes', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {
      items: [],
      summary: { total: 0, notContacted: 0, overdue: 0, unreturnedCalls: 0 },
      cursorInfo: { hasMore: false },
    } }))
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    await client.getLeads({
      search: 'Ramesh & Sons',
      queue: 'overdue',
      statusId: 'status/qualified',
      assignedEmployeeId: 'employee one',
      limit: 25,
    }, 'lead-token')
    const url = new URL(String(fetcher.mock.calls[0][0]))

    expect(url.pathname).toBe('/v1/leads')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '25',
      search: 'Ramesh & Sons',
      queue: 'overdue',
      statusId: 'status/qualified',
      assignedEmployeeId: 'employee one',
    })
    expect((fetcher.mock.calls[0][1]?.headers as Headers).get('Authorization')).toBe('Bearer lead-token')

    fetcher.mockResolvedValueOnce(jsonResponse({ ok: true, data: { items: [] } }))
    await client.getLeadOwners('lead-token')
    expect(String(fetcher.mock.calls[1][0]).endsWith('/v1/lead-owners')).toBe(true)
  })

  it('sends compare-and-swap updates and lead workflow mutations to exact routes', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }))
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    await client.updateLead('lead/one', {
      expectedVersion: 4,
      changes: { statusId: 'status-qualified', assignedEmployeeId: 'employee-2' },
    }, 'lead-token')
    await client.addLeadNote('lead/one', { body: 'Interested in the annual order.' }, 'lead-token')
    await client.createLeadFollowUp('lead/one', {
      leadId: 'lead/one',
      assignedEmployeeId: 'employee-2',
      title: 'Discuss annual order',
      dueAt: '2026-07-16T08:30:00.000Z',
      priority: 'high',
    }, 'lead-token')
    await client.completeFollowUp('follow/up', { expectedVersion: 2 }, 'lead-token')

    expect(String(fetcher.mock.calls[0][0]).endsWith('/v1/leads/lead%2Fone')).toBe(true)
    expect(fetcher.mock.calls[0][1]?.method).toBe('PATCH')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      expectedVersion: 4,
      changes: { statusId: 'status-qualified', assignedEmployeeId: 'employee-2' },
    })
    expect(String(fetcher.mock.calls[1][0]).endsWith('/v1/leads/lead%2Fone/notes')).toBe(true)
    expect(String(fetcher.mock.calls[2][0]).endsWith('/v1/leads/lead%2Fone/follow-ups')).toBe(true)
    expect(String(fetcher.mock.calls[3][0]).endsWith('/v1/follow-ups/follow%2Fup/complete')).toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({ expectedVersion: 2 })
  })
})

describe('CalloraApiClient lead operations routes', () => {
  it('uses exact import, assignment and correction mutation routes with stable request keys', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ ok: true, data: {} }))
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })
    const requestId = '8c6820bb-c7f4-4f8f-8ee6-2e9e0ad21da6'

    await client.previewLeadImport({
      requestId,
      fileName: 'leads.csv',
      rows: [{ firstName: '', phoneNumber: '' }],
    }, 'lead-token')
    await client.commitLeadImport('job/one', { requestId }, 'lead-token')
    await client.dryRunLeadAssignmentRules('lead-token')
    await client.applyLeadAssignmentRules({ requestId, includeExistingUnassigned: true }, 'lead-token')
    await client.correctCallLeadLink('call/one', {
      requestId,
      expectedLeadId: 'lead-old',
      replacementLeadId: 'lead-new',
      reason: 'The incoming number belonged to a different customer.',
    }, 'lead-token')

    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/v1/lead-imports/preview')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).rows).toEqual([{ firstName: '', phoneNumber: '' }])
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe('/v1/lead-imports/job%2Fone/commit')
    expect(new URL(String(fetcher.mock.calls[2][0])).pathname).toBe('/v1/lead-assignment-rules/dry-run')
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({})
    expect(new URL(String(fetcher.mock.calls[3][0])).pathname).toBe('/v1/lead-assignment-rules/apply')
    expect(new URL(String(fetcher.mock.calls[4][0])).pathname).toBe('/v1/calls/call%2Fone/lead-link/correct')
    for (const callIndex of [0, 1, 3, 4]) {
      expect((fetcher.mock.calls[callIndex][1]?.headers as Headers).get('Idempotency-Key')).toBe(requestId)
    }
  })

  it('encodes report filters and downloads import errors without ambient cookies', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/errors')) {
        return {
          blob: async () => new Blob(['row,message\r\n2,Invalid phone\r\n'], { type: 'text/csv' }),
          headers: new Headers({ 'Content-Disposition': "attachment; filename*=UTF-8''invalid%20leads.csv" }),
          ok: true,
          status: 200,
        } as Response
      }
      return jsonResponse({ ok: true, data: {} })
    })
    const client = new CalloraApiClient({ fetcher: fetcher as typeof fetch })

    await client.getLeadReport({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
      employeeId: 'employee one',
      team: 'West & Enterprise',
      source: 'google_ads',
    }, 'lead-token')
    const downloaded = await client.downloadLeadImportErrors('job/one', 'lead-token')
    const reportUrl = new URL(String(fetcher.mock.calls[0][0]))

    expect(reportUrl.pathname).toBe('/v1/lead-reports')
    expect(Object.fromEntries(reportUrl.searchParams)).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
      employeeId: 'employee one',
      team: 'West & Enterprise',
      source: 'google_ads',
    })
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe('/v1/lead-imports/job%2Fone/errors')
    expect(fetcher.mock.calls[1][1]?.credentials).toBe('omit')
    expect((fetcher.mock.calls[1][1]?.headers as Headers).get('Accept')).toBe('text/csv')
    expect(downloaded.fileName).toBe('invalid leads.csv')
    expect(downloaded.blob.type).toBe('text/csv')
    expect(downloaded.blob.size).toBeGreaterThan(0)
  })
})
