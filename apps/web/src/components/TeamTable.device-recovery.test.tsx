import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EmployeeRow } from '../types'
import { TeamTable } from './TeamTable'

const employee: EmployeeRow = {
  id: 'employee-1',
  name: 'Kiran Shah',
  initials: 'KS',
  color: '#dff4ec',
  calls: 12,
  connected: 8,
  talkMinutes: 42,
  followUps: 3,
  status: 'Active',
  deviceIds: ['device-1', 'device-2'],
}

describe('TeamTable administrator device recovery', () => {
  it('requires an explicit reason and revokes the selected device', async () => {
    const onRevokeDevice = vi.fn(async () => true)
    render(
      <TeamTable
        canManageDevices
        employees={[employee]}
        onRevokeDevice={onRevokeDevice}
        searchQuery=""
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Kiran Shah' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke a stranded device' }))

    const dialog = screen.getByRole('dialog', { name: 'Revoke Kiran Shah’s device' })
    const submit = within(dialog).getByRole('button', { name: 'Revoke device' })
    expect(submit).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('Device'), { target: { value: 'device-2' } })
    fireEvent.change(within(dialog).getByLabelText('Operational reason'), {
      target: { value: 'Credential was lost during a managed phone replacement.' },
    })
    fireEvent.click(submit)

    expect(onRevokeDevice).toHaveBeenCalledWith(
      'device-2',
      'Credential was lost during a managed phone replacement.',
    )
    expect(await screen.findByRole('button', { name: 'More actions for Kiran Shah' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Kiran Shah' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke a stranded device' }))
    expect(within(screen.getByRole('dialog')).queryByRole('option', { name: 'device-2' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: 'device-1' })).toBeInTheDocument()
  })

  it('does not expose recovery actions without devices.manage', () => {
    render(
      <TeamTable
        canManageDevices={false}
        employees={[employee]}
        onRevokeDevice={vi.fn()}
        searchQuery=""
      />,
    )

    expect(screen.queryByRole('button', { name: 'More actions for Kiran Shah' })).not.toBeInTheDocument()
  })
})
