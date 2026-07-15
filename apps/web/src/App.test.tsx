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

const testTimestamp = '2026-07-14T05:00:00.000Z'

function devSessionResponse(): Response {
  return jsonResponse({ ok: true, data: {
    accessToken: 'test-access-token',
    tokenType: 'Bearer',
    expiresAt: '2026-07-15T05:00:00.000Z',
    actor: {
      userId: 'user-owner',
      displayName: 'Test Owner',
      email: 'owner@example.com',
      organizationId: 'org_alpha',
      organizationName: 'Alpha Calls',
      role: 'owner',
      permissions: ['employees.read', 'employees.manage'],
    },
  } })
}

function emptyOverview() {
  return {
    summary: {
      organizationId: 'org_alpha',
      generatedAt: testTimestamp,
      period: { from: testTimestamp, to: '2026-07-15T05:00:00.000Z' },
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('API offline for deterministic tests')))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Callora dashboard', () => {
  it('updates dashboard metrics when the date range changes', async () => {
    render(<App />)

    await screen.findByRole('status', { name: 'Data source: Demo data · API unavailable' })
    const metrics = screen.getByRole('region', { name: 'Key metrics' })
    expect(within(metrics).getByText('428')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'Yesterday' } })

    expect(await screen.findByText('381')).toBeInTheDocument()
    expect(within(metrics).queryByText('428')).not.toBeInTheDocument()
  })

  it('adds an explicitly local employee through the onboarding dialog when offline', async () => {
    render(<App />)

    await screen.findByRole('status', { name: 'Data source: Demo data · API unavailable' })
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Kiran Shah' } })
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '+91 98765 00000' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add employee' }))

    expect(await screen.findAllByText('Kiran Shah')).toHaveLength(2)
    expect(screen.getByText('Local draft · not synced')).toBeInTheDocument()
    expect(screen.getByText('Kiran Shah added as a local draft · not synced')).toBeInTheDocument()
  })

  it('opens a planned module and returns to the dashboard', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Leads' }))
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Return to dashboard' }))

    expect(screen.getByRole('heading', { name: 'Team calling overview' })).toBeInTheDocument()
  })

  it('loads live overview and employees in parallel, then sends filter and employee mutations to the API', async () => {
    const timestamp = '2026-07-14T05:00:00.000Z'
    const employee = {
      id: 'emp-remote',
      organizationId: 'org_alpha',
      displayName: 'Remote Agent',
      primaryPhone: '+919876543210',
      status: 'active',
      deviceIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const overview = {
      summary: {
        organizationId: 'org_alpha',
        generatedAt: timestamp,
        period: { from: timestamp, to: '2026-07-15T05:00:00.000Z' },
        preset: 'today',
        calls: {
          totalCalls: 912,
          incomingCalls: 420,
          outgoingCalls: 492,
          answeredCalls: 701,
          missedCalls: 51,
          rejectedCalls: 12,
          connectedCalls: 701,
          neverAttendedCalls: 9,
          clientNotPickupCalls: 22,
          uniqueClients: 388,
          totalTalkDurationSeconds: 45_300,
          averageTalkDurationSeconds: 65,
          answerRate: 76.9,
        },
        leads: {
          totalLeads: 80,
          newLeads: 11,
          contactedLeads: 56,
          uncontactedLeads: 24,
          dueFollowUps: 8,
          overdueFollowUps: 5,
          wonLeads: 12,
          lostLeads: 7,
          conversionRate: 15,
        },
        comparisons: {
          totalCalls: { current: 912, previous: 800, percentageChange: 14, trend: 'up' },
        },
      },
      metrics: {
        totalCalls: 912,
        totalTalkDurationSeconds: 45_300,
        connectedCalls: 701,
        missedCalls: 51,
        uniqueClients: 388,
        workingHoursSeconds: 29_700,
      },
      hourlyActivity: [
        { hour: '09', label: '9 AM', incoming: 40, outgoing: 51 },
        { hour: '10', label: '10 AM', incoming: 50, outgoing: 64 },
      ],
      outcomes: [
        { key: 'connected', label: 'Connected', value: 701, color: '#12a983' },
        { key: 'busy', label: 'Busy', value: 211, color: '#ff9d36' },
      ],
      attention: [
        { key: 'missed', label: 'Missed calls not returned', value: 6 },
        { key: 'leads', label: 'Leads overdue', value: 5 },
        { key: 'devices', label: 'Devices offline', value: 1 },
      ],
      teamPerformance: [{
        employeeId: 'emp-remote',
        employeeName: 'Remote Agent',
        totalCalls: 912,
        connectedCalls: 701,
        missedCalls: 51,
        uniqueClients: 388,
        talkDurationSeconds: 45_300,
        averageCallDurationSeconds: 65,
        answerRate: 76.9,
        assignedLeads: 80,
        contactedLeads: 56,
        wonLeads: 12,
        overdueFollowUps: 5,
      }],
      recentActivity: [{
        id: 'activity-remote',
        kind: 'connected',
        title: 'Remote Agent connected a call',
        detail: '+91 99999 00000',
        occurredAt: timestamp,
      }],
    }

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/v1/dev/session')) {
        return jsonResponse({ ok: true, data: {
          accessToken: 'test-access-token',
          tokenType: 'Bearer',
          expiresAt: '2026-07-15T05:00:00.000Z',
          actor: {
            userId: 'user-owner',
            displayName: 'Test Owner',
            email: 'owner@example.com',
            organizationId: 'org_alpha',
            organizationName: 'Alpha Calls',
            role: 'owner',
            permissions: ['employees.read', 'employees.manage'],
          },
        } })
      }
      if (url.includes('/v1/dashboard/overview')) {
        return jsonResponse({ ok: true, data: overview })
      }
      if (url.includes('/v1/employees') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { displayName: string; primaryPhone?: string }
        return jsonResponse({ ok: true, data: {
          ...employee,
          id: 'emp-created',
          displayName: body.displayName,
          primaryPhone: body.primaryPhone,
          status: 'invited',
        } }, 201)
      }
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [employee], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(screen.getByRole('status', { name: 'Data source: Loading live data' })).toBeInTheDocument()
    expect(await screen.findByRole('status', { name: 'Data source: Live data' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Key metrics' })).getByText('912')).toBeInTheDocument()
    expect(screen.getAllByText('Remote Agent')).toHaveLength(2)

    const overviewCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/dashboard/overview'))
    const employeeListCall = fetchMock.mock.calls.find(([url, init]) => (
      String(url).includes('/v1/employees') && (init?.method ?? 'GET') === 'GET'
    ))
    expect(overviewCall).toBeDefined()
    expect(employeeListCall).toBeDefined()
    expect((overviewCall?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer test-access-token')

    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'Yesterday' } })
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('preset=yesterday'))).toBe(true))

    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'emp-remote' } })
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('employeeId=emp-remote'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'API Created Agent' } })
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '+91 98765 11111' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add employee' }))

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => (
        String(url).endsWith('/v1/employees') && init?.method === 'POST'
      ))
      expect(createCall).toBeDefined()
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
        displayName: 'API Created Agent',
        primaryPhone: '+919876511111',
      })
    })
    expect(await screen.findByText('API Created Agent added to your team')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Employee')).getByRole('option', { name: 'API Created Agent' })).toHaveValue('emp-created')
  })

  it('shows a deterministic demo fallback when the API is unavailable', async () => {
    render(<App />)

    expect(screen.getByRole('status', { name: 'Data source: Loading live data' })).toBeInTheDocument()
    expect(await screen.findByRole('status', { name: 'Data source: Demo data · API unavailable' })).toBeInTheDocument()
    const metrics = screen.getByRole('region', { name: 'Key metrics' })
    expect(within(metrics).getByText('428')).toBeInTheDocument()
    expect(screen.getAllByText('Amit Patel')).toHaveLength(2)
  })

  it('renders honest zero and empty states for a successful live response', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/dev/session')) return devSessionResponse()
      if (url.includes('/v1/dashboard/overview')) return jsonResponse({ ok: true, data: emptyOverview() })
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByRole('status', { name: 'Data source: Live data' })
    expect(screen.getByText('No call activity for this period.')).toBeInTheDocument()
    expect(screen.getByText('No call outcomes yet.')).toBeInTheDocument()
    expect(screen.getByText('No recent activity for this period.')).toBeInTheDocument()
    expect(screen.getAllByText('No comparison available')).toHaveLength(6)
    expect(screen.queryByText('Amit Patel connected a call')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('NaN')
  })

  it('does not leave a phantom employee when a live create request fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/dev/session')) return devSessionResponse()
      if (url.includes('/v1/dashboard/overview')) return jsonResponse({ ok: true, data: emptyOverview() })
      if (url.endsWith('/v1/employees') && init?.method === 'POST') {
        return jsonResponse({ ok: false, error: { code: 'CREATE_FAILED', message: 'Create blocked' } }, 500)
      }
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: { items: [], cursorInfo: { hasMore: false } } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByRole('status', { name: 'Data source: Live data' })
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Rejected Agent' } })
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '+91 98765 22222' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add employee' }))

    expect(await screen.findByText('Could not add Rejected Agent: Create blocked')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).queryByText('Rejected Agent')).not.toBeInTheDocument()
    expect(screen.queryByText('Local draft · not synced')).not.toBeInTheDocument()
  })

  it('uses employee IDs for duplicate-name filter options and requests', async () => {
    const employee = (id: string) => ({
      id,
      organizationId: 'org_alpha',
      displayName: 'Same Name',
      primaryPhone: id === 'emp-first' ? '+919000000001' : '+919000000002',
      status: 'active',
      deviceIds: [],
      createdAt: testTimestamp,
      updatedAt: testTimestamp,
    })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/dev/session')) return devSessionResponse()
      if (url.includes('/v1/dashboard/overview')) return jsonResponse({ ok: true, data: emptyOverview() })
      if (url.includes('/v1/employees')) {
        return jsonResponse({ ok: true, data: {
          items: [employee('emp-first'), employee('emp-second')],
          cursorInfo: { hasMore: false },
        } })
      }
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByRole('status', { name: 'Data source: Live data' })
    const select = screen.getByLabelText('Employee')
    const duplicateOptions = within(select).getAllByRole('option', { name: 'Same Name' }) as HTMLOptionElement[]
    expect(duplicateOptions.map((option) => option.value)).toEqual(['emp-first', 'emp-second'])

    fireEvent.change(select, { target: { value: 'emp-second' } })
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => (
      String(url).includes('employeeId=emp-second')
    ))).toBe(true))
  })
})
