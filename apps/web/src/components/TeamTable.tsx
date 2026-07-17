import { useDeferredValue, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpDown, MoreVertical, ShieldAlert } from 'lucide-react'
import type { EmployeeRow } from '../types'
import { connectionRate, downloadEmployeeCsv, formatTalkTime } from '../utils'
import { DeviceRevocationDialog } from './DeviceRevocationDialog'

type SortKey = 'name' | 'calls' | 'connected' | 'talkMinutes' | 'followUps' | 'status'

interface TeamTableProps {
  canManageDevices?: boolean
  employees: EmployeeRow[]
  onRevokeDevice?: (deviceId: string, reason: string) => Promise<boolean>
  searchQuery: string
}

export function TeamTable({
  canManageDevices = false,
  employees,
  onRevokeDevice,
  searchQuery,
}: TeamTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'calls', direction: 'desc' })
  const [actionEmployeeId, setActionEmployeeId] = useState<string | null>(null)
  const [recoveryEmployeeId, setRecoveryEmployeeId] = useState<string | null>(null)
  const [revokedDeviceIds, setRevokedDeviceIds] = useState<Set<string>>(() => new Set())
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase())

  const visibleEmployees = useMemo(() => {
    const filtered = deferredSearch
      ? employees.filter((employee) => employee.name.toLowerCase().includes(deferredSearch))
      : employees
    return [...filtered].sort((a, b) => {
      const left = a[sort.key]
      const right = b[sort.key]
      const result = typeof left === 'number'
        ? left - (right as number)
        : String(left).localeCompare(String(right))
      return sort.direction === 'asc' ? result : -result
    })
  }, [deferredSearch, employees, sort])

  const changeSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  const headers: Array<{ label: string; key: SortKey }> = [
    { label: 'Employee', key: 'name' },
    { label: 'Calls', key: 'calls' },
    { label: 'Connected', key: 'connected' },
    { label: 'Talk time', key: 'talkMinutes' },
    { label: 'Follow-ups', key: 'followUps' },
    { label: 'Status', key: 'status' },
  ]
  const recoveryEmployee = recoveryEmployeeId
    ? employees.find((employee) => employee.id === recoveryEmployeeId)
    : undefined
  const recoverableDeviceIds = recoveryEmployee?.deviceIds?.filter((id) => !revokedDeviceIds.has(id)) ?? []

  const revokeDevice = async (deviceId: string, reason: string): Promise<boolean> => {
    if (!onRevokeDevice) return false
    const wasRevoked = await onRevokeDevice(deviceId, reason)
    if (wasRevoked) {
      setRevokedDeviceIds((current) => new Set([...current, deviceId]))
    }
    return wasRevoked
  }

  return (
    <section className="panel team-panel">
      <div className="panel-heading team-panel__heading">
        <div>
          <h2>Team performance</h2>
        </div>
        <button className="select-button select-button--small" onClick={() => downloadEmployeeCsv(visibleEmployees)} type="button">
          <ArrowDownToLine size={16} /> Export
        </button>
      </div>
      <p className="table-scroll-hint">Swipe to view all columns</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header.key}>
                  <button onClick={() => changeSort(header.key)} type="button">
                    {header.label}
                    <ArrowUpDown className={sort.key === header.key ? 'sort-icon--active' : ''} size={14} />
                  </button>
                </th>
              ))}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visibleEmployees.length > 0 ? visibleEmployees.map((employee) => (
              <tr key={employee.id}>
                <td>
                  <div className="employee-cell">
                    <span className="employee-avatar" style={{ background: employee.color }}>{employee.initials}</span>
                    <span className="employee-name">
                      <strong>{employee.name}</strong>
                      {employee.isLocalOnly ? <small>Local draft · not synced</small> : null}
                    </span>
                  </div>
                </td>
                <td>{employee.calls}</td>
                <td><strong className="connected-value">{employee.connected}</strong> <span className="cell-muted">({connectionRate(employee)})</span></td>
                <td>{formatTalkTime(employee.talkMinutes)}</td>
                <td>{employee.followUps}</td>
                <td><span className={`status status--${employee.status.toLowerCase()}`}><i />{employee.status}</span></td>
                <td className="row-actions">
                  {canManageDevices && onRevokeDevice && (employee.deviceIds?.length ?? 0) > 0 ? (
                    <>
                      <button
                        aria-expanded={actionEmployeeId === employee.id}
                        aria-haspopup="menu"
                        aria-label={`More actions for ${employee.name}`}
                        className="icon-button row-menu"
                        onClick={() => setActionEmployeeId((current) => current === employee.id ? null : employee.id)}
                        type="button"
                      >
                        <MoreVertical size={17} />
                      </button>
                      {actionEmployeeId === employee.id ? (
                        <div aria-label={`Device actions for ${employee.name}`} className="row-action-menu" role="menu">
                          <button
                            disabled={(employee.deviceIds ?? []).every((id) => revokedDeviceIds.has(id))}
                            onClick={() => {
                              setRecoveryEmployeeId(employee.id)
                              setActionEmployeeId(null)
                            }}
                            role="menuitem"
                            type="button"
                          >
                            <ShieldAlert size={15} /> Revoke a stranded device
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </td>
              </tr>
            )) : (
              <tr>
                <td className="empty-table" colSpan={7}>No team member matches “{searchQuery}”.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="table-footer">
        <span>Showing {visibleEmployees.length} of {employees.length} employees</span>
        <div className="pagination" aria-label="Table pagination">
          <button aria-current="page" type="button">1</button>
        </div>
      </footer>
      {recoveryEmployee && recoverableDeviceIds.length > 0 ? (
        <DeviceRevocationDialog
          deviceIds={recoverableDeviceIds}
          employeeName={recoveryEmployee.name}
          onClose={() => setRecoveryEmployeeId(null)}
          onRevoke={revokeDevice}
        />
      ) : null}
    </section>
  )
}
