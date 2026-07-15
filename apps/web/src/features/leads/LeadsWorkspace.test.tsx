import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../../auth/types'
import { LeadsWorkspace } from './LeadsWorkspace'

function authSession(mode: 'dev' | 'oidc', getAccessToken: AuthSession['getAccessToken']): AuthSession {
  return {
    mode,
    canSignIn: true,
    initialize: async () => ({ status: 'signed_in', user: { subject: 'test-user', displayName: 'Test User' } }),
    getAccessToken,
    signIn: async () => undefined,
    signOut: async () => undefined,
    clear: async () => undefined,
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    json: async () => data,
    ok: status >= 200 && status < 300,
    status,
  } as Response
}

const timestamp = '2026-07-14T05:00:00.000Z'
const status = {
  id: 'status-new',
  organizationId: 'org-alpha',
  name: 'New',
  color: '#2f83ee',
  position: 1,
  isInitial: true,
  isWon: false,
  isLost: false,
  isActive: true,
}
const canonicalLead = {
  id: 'lead-live',
  organizationId: 'org-alpha',
  firstName: 'Live',
  lastName: 'Buyer',
  companyName: 'Live Buyer Co',
  phoneNumber: '+919999900000',
  source: 'website',
  statusId: status.id,
  assignedEmployeeId: 'emp-live',
  tagIds: [],
  customFields: {},
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}
const canonicalItem = {
  lead: canonicalLead,
  status,
  assignedEmployee: { id: 'emp-live', displayName: 'Live Owner' },
  overdueFollowUpCount: 0,
  unreturnedMissedCallCount: 0,
}
const canonicalDetail = {
  item: canonicalItem,
  notes: [],
  followUps: [],
  activities: [{
    id: 'activity-live',
    organizationId: 'org-alpha',
    leadId: canonicalLead.id,
    kind: 'created',
    occurredAt: timestamp,
    summary: 'Lead created',
  }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Phase 4A lead workspace', () => {
  it('renders the accepted split pipeline and filters deterministic dev fallback data', async () => {
    const session = authSession('dev', async () => { throw new TypeError('API offline') })
    render(
      <LeadsWorkspace
        authSession={session}
        onAuthenticationFailure={vi.fn()}
        onNotify={vi.fn()}
        onSearchChange={vi.fn()}
        searchQuery=""
      />,
    )

    expect(await screen.findByRole('status', { name: 'Lead data source: Demo data, local drafts only' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lead pipeline' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('Ramesh Traders')
    await screen.findByText('Discuss annual order')
    expect(screen.getByRole('complementary', { name: 'Ramesh Traders' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All leads' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Not contacted' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Overdue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unreturned calls' })).toBeInTheDocument()
  })

  it('creates clearly local lead, note and follow-up drafts and completes the next action', async () => {
    const notify = vi.fn()
    const session = authSession('dev', async () => { throw new TypeError('API offline') })
    render(
      <LeadsWorkspace
        authSession={session}
        onAuthenticationFailure={vi.fn()}
        onNotify={notify}
        onSearchChange={vi.fn()}
        searchQuery=""
      />,
    )

    await screen.findByRole('status', { name: 'Lead data source: Demo data, local drafts only' })
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }))
    const addDialog = screen.getByRole('dialog', { name: 'Add a lead' })
    fireEvent.change(within(addDialog).getByLabelText('First name'), { target: { value: 'Kiran' } })
    fireEvent.change(within(addDialog).getByLabelText('Company'), { target: { value: 'Kiran Industries' } })
    fireEvent.change(within(addDialog).getByLabelText('Mobile number'), { target: { value: '+91 98765 11111' } })
    fireEvent.change(within(addDialog).getByLabelText('Owner'), { target: { value: 'emp-2' } })
    fireEvent.click(within(addDialog).getByRole('button', { name: 'Save local draft' }))

    expect(await screen.findByRole('complementary', { name: 'Kiran Industries' })).toHaveTextContent('Local draft')
    expect(screen.getByRole('table')).toHaveTextContent('Local draft · not synced')
    expect(notify).toHaveBeenCalledWith('Kiran Industries added as a local draft · not synced')

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Kiran Industries' })).getByRole('button', { name: 'Add note' }))
    const noteDialog = screen.getByRole('dialog', { name: 'Add a note for Kiran Industries' })
    fireEvent.change(within(noteDialog).getByLabelText('Note'), { target: { value: 'Asked for the annual pricing sheet.' } })
    fireEvent.click(within(noteDialog).getByRole('button', { name: 'Save local note' }))
    expect(await screen.findByText(/Asked for the annual pricing sheet\./)).toBeInTheDocument()

    const detail = screen.getByRole('complementary', { name: 'Kiran Industries' })
    fireEvent.click(within(detail).getByRole('button', { name: 'Schedule follow-up' }))
    const followUpDialog = screen.getByRole('dialog', { name: 'Schedule follow-up' })
    fireEvent.change(within(followUpDialog).getByLabelText('Action'), { target: { value: 'Review annual pricing' } })
    fireEvent.click(within(followUpDialog).getByRole('button', { name: 'Save local follow-up' }))
    expect(await screen.findByText('Review annual pricing')).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Kiran Industries' })).getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Follow-up completed as a local draft · not synced'))
    expect(within(screen.getByRole('complementary', { name: 'Kiran Industries' })).getByRole('button', { name: 'Schedule the next action' })).toBeInTheDocument()
  })

  it('separates read, manage and assign permissions for a live workspace', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:4100')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/session')) return jsonResponse({ ok: true, data: {
        userId: 'user-live',
        displayName: 'Read Only',
        email: 'read@example.com',
        organizationId: 'org-alpha',
        organizationName: 'Alpha',
        role: 'analyst',
        permissions: ['leads.read'],
      } })
      if (url.endsWith('/v1/lead-statuses')) return jsonResponse({ ok: true, data: { items: [status] } })
      if (url.endsWith('/v1/lead-owners')) return jsonResponse({ ok: true, data: { items: [{ id: 'emp-live', displayName: 'Live Owner' }] } })
      if (url.includes('/v1/leads?')) return jsonResponse({ ok: true, data: {
        items: [canonicalItem],
        summary: { total: 1, notContacted: 1, overdue: 0, unreturnedCalls: 0 },
        cursorInfo: { hasMore: false },
        generatedAt: timestamp,
        timeZone: 'Asia/Kolkata',
      } })
      if (url.endsWith('/v1/leads/lead-live')) return jsonResponse({ ok: true, data: canonicalDetail })
      return jsonResponse({ ok: false, error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const session = authSession('oidc', async () => 'live-token')
    render(
      <LeadsWorkspace
        authSession={session}
        onAuthenticationFailure={vi.fn()}
        onNotify={vi.fn()}
        onSearchChange={vi.fn()}
        searchQuery=""
      />,
    )

    expect(await screen.findByRole('complementary', { name: 'Live Buyer Co' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add lead' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Lead status')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Lead owner')).not.toBeInTheDocument()
    expect(within(screen.getByRole('complementary', { name: 'Live Buyer Co' })).getByRole('button', { name: 'Add note' })).toBeDisabled()
    expect(within(screen.getByRole('complementary', { name: 'Live Buyer Co' })).getByRole('button', { name: 'Schedule follow-up' })).toBeDisabled()
  })

  it('never falls back to demo data in OIDC mode', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:4100')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('production API offline')))
    const onAuthenticationFailure = vi.fn()
    const session = authSession('oidc', async () => 'oidc-token')
    render(
      <LeadsWorkspace
        authSession={session}
        onAuthenticationFailure={onAuthenticationFailure}
        onNotify={vi.fn()}
        onSearchChange={vi.fn()}
        searchQuery=""
      />,
    )

    await waitFor(() => expect(onAuthenticationFailure).toHaveBeenCalledWith('service_unavailable'))
    expect(screen.queryByText('Ramesh Traders')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Lead data source: Demo data, local drafts only' })).not.toBeInTheDocument()
  })
})
