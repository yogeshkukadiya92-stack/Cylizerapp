import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReportAutomationPage } from './ReportAutomationPage'

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
})
