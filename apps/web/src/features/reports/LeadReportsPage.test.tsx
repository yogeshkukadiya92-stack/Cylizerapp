import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LeadReportsPage, type LeadReportFilterDraft } from './LeadReportsPage'
import { demoLeadReport } from './data'

const filters: LeadReportFilterDraft = {
  from: '2026-07-01',
  to: '2026-07-31',
  employeeId: '',
  team: '',
  source: '',
}

describe('LeadReportsPage', () => {
  it('renders accessible KPI, pipeline, trend, owner and source evidence', () => {
    render(<LeadReportsPage
      canExport
      dataSource={{ status: 'live', error: null }}
      employees={[{ id: 'emp-2', name: 'Priya Sharma' }]}
      filters={filters}
      isRefreshing={false}
      onApplyFilters={vi.fn()}
      onExport={vi.fn()}
      onFilterChange={vi.fn()}
      report={demoLeadReport}
      searchQuery=""
      teams={['West']}
    />)

    expect(screen.getByRole('heading', { name: 'Lead reports' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Report data source: live' })).toHaveTextContent('Live data')
    expect(within(screen.getByRole('region', { name: 'Lead report key metrics' })).getByText('18.6%')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pipeline conversion' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Leads created and won over time' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Lead trend values' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Owner performance' })).toBeInTheDocument()
    expect(screen.getAllByText('Priya Sharma').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Google Ads').length).toBeGreaterThan(0)
  })

  it('keeps draft filters explicit and gates CSV export by permission', () => {
    const onApplyFilters = vi.fn()
    const onExport = vi.fn()
    const onFilterChange = vi.fn()
    const { rerender } = render(<LeadReportsPage
      canExport={false}
      dataSource={{ status: 'demo', error: 'API unavailable' }}
      employees={[]}
      filters={filters}
      isRefreshing={false}
      onApplyFilters={onApplyFilters}
      onExport={onExport}
      onFilterChange={onFilterChange}
      report={demoLeadReport}
      searchQuery=""
      teams={[]}
    />)

    const filterRegion = screen.getByRole('region', { name: 'Lead report filters' })
    fireEvent.change(within(filterRegion).getByLabelText('From'), { target: { value: '2026-07-05' } })
    fireEvent.click(within(filterRegion).getByRole('button', { name: 'Apply filters' }))
    expect(onFilterChange).toHaveBeenCalledWith({ from: '2026-07-05' })
    expect(onApplyFilters).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()

    rerender(<LeadReportsPage
      canExport
      dataSource={{ status: 'demo', error: null }}
      employees={[]}
      filters={filters}
      isRefreshing={false}
      onApplyFilters={onApplyFilters}
      onExport={onExport}
      onFilterChange={onFilterChange}
      report={demoLeadReport}
      searchQuery="Priya"
      teams={[]}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(onExport).toHaveBeenCalledOnce()
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument()
    expect(screen.queryByText('Amit Patel')).not.toBeInTheDocument()
  })
})
