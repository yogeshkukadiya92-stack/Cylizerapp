import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OutcomeChart } from './OutcomeChart'

describe('OutcomeChart', () => {
  it('renders zero-valued outcomes without NaN percentages', () => {
    render(<OutcomeChart outcomes={[
      { label: 'Connected', value: 0, color: '#12a983' },
      { label: 'Busy', value: 0, color: '#ff9d36' },
    ]} />)

    expect(screen.getAllByText('0.0%')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('NaN')
  })
})
