// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrendReadoutView } from '../TrendReadout'

// uPlot needs a canvas; the readout words are what these specs pin.
vi.mock('../../../charts/Sparkline', () => ({
  Sparkline: () => <span data-testid="sparkline" />,
}))

afterEach(cleanup)

const DAY_MS = 86_400_000
const pts = (values: readonly (number | null)[]) => values.map((v, i) => ({ x: i * 60_000, v }))

describe('the device card trend readout', () => {
  it('draws the Y min and max, the span, the unit and the latest value', () => {
    render(
      <TrendReadoutView
        testId="t"
        label="Temperature"
        points={pts([42, 48.4, 47])}
        quantity="temperature"
        windowMs={DAY_MS}
      />,
    )
    expect(screen.getByTestId('dc-trend-max').textContent).toBe('48.4')
    expect(screen.getByTestId('dc-trend-min').textContent).toBe('42')
    expect(screen.getByTestId('dc-trend-current').textContent).toBe('47')
    expect(screen.getByTestId('t').textContent).toContain('°C')
    expect(screen.getByTestId('dc-trend-start').textContent).toBe('24 h ago')
    expect(screen.getByText('now')).toBeTruthy()
  })

  it('draws nothing for a series that has not answered: no scale, no 0', () => {
    const { container } = render(
      <TrendReadoutView
        testId="t"
        label="x"
        points={pts([null, null])}
        unit="W"
        windowMs={DAY_MS}
      />,
    )
    expect(container.firstChild).toBeNull()
    cleanup()
    const empty = render(
      <TrendReadoutView testId="t" label="x" points={[]} unit="W" windowMs={DAY_MS} />,
    )
    expect(empty.container.firstChild).toBeNull()
  })
})
