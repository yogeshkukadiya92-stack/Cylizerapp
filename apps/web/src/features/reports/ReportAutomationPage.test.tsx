import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReportAutomationPage } from './ReportAutomationPage'
import type { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'

describe('ReportAutomationPage', () => {
  it('renders the Phase 5A operational surfaces and saves preference state', async () => {
    const onNotify = vi.fn()
    render(<ReportAutomationPage onNotify={onNotify} />)
    expect(screen.getByRole('heading', { name: 'Scheduled reports' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Saved views' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Notification preferences' })).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'device_offline in-app' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Notification preference saved'))
  })

  it('opens an accessible schedule editor and validates required delivery fields', async () => {
    const onNotify = vi.fn()
    render(<ReportAutomationPage onNotify={onNotify} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    const dialog = screen.getByRole('dialog', { name: 'Create report schedule' })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create schedule' }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Enter a schedule name and at least one recipient'))
  })

  it('mints a grant and downloads a ready report', async () => {
    const onNotify=vi.fn(); const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{}); vi.stubGlobal('URL',{...URL,createObjectURL:vi.fn(()=> 'blob:report'),revokeObjectURL:vi.fn()})
    const client={getReportAutomation:vi.fn().mockResolvedValue({savedViews:[],schedules:[],preferences:[],jobs:[{id:'job-ready',kind:'lead_performance',format:'csv',status:'ready',requestedAt:'2026-07-15T09:02:00.000Z'}]}),issueReportDownloadToken:vi.fn().mockResolvedValue({token:'clr_token',expiresAt:'2026-07-17T00:00:00.000Z'}),downloadReport:vi.fn().mockResolvedValue({blob:new Blob(['calls']),fileName:'report.csv'})} as unknown as CalloraApiClient
    const authSession={mode:'dev',canSignIn:true,getAccessToken:vi.fn().mockResolvedValue('access'),initialize:vi.fn(),signIn:vi.fn(),signOut:vi.fn(),clear:vi.fn()} as unknown as AuthSession
    render(<ReportAutomationPage authSession={authSession} client={client} onNotify={onNotify}/>)
    fireEvent.click(await screen.findByRole('button',{name:'Download'}))
    await waitFor(()=>expect(onNotify).toHaveBeenCalledWith('Report downloaded'))
    expect(client.issueReportDownloadToken).toHaveBeenCalledWith('job-ready','access'); expect(client.downloadReport).toHaveBeenCalledWith('job-ready','clr_token','access'); expect(click).toHaveBeenCalled(); click.mockRestore(); vi.unstubAllGlobals()
  })
})
