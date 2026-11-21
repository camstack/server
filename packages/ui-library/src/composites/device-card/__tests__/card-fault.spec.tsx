// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CardFaults } from '../shell/DeviceCard'
import { cardFaultsOf } from '../shell/model'

afterEach(cleanup)

const slice = (active: boolean | null) => ({
  active,
  code: '38',
  label: 'Dust bin missing',
  severity: 'error' as const,
})

describe('cardFaultsOf — only an answered `active: true` is a fault', () => {
  it('lists nothing for an absent cap, an unread slice and a clear one', () => {
    expect(cardFaultsOf(undefined)).toEqual([])
    expect(cardFaultsOf(slice(null))).toEqual([])
    expect(cardFaultsOf(slice(false))).toEqual([])
  })

  it('lists the principal fault of an active slice', () => {
    expect(cardFaultsOf(slice(true))).toEqual([{ label: 'Dust bin missing', severity: 'error' }])
  })

  it('lists every fault of a device that raises several', () => {
    const several = {
      ...slice(true),
      faults: [
        { code: '38', label: 'Dust bin missing', severity: 'error' as const },
        { code: '7', label: 'Low temp', severity: 'warning' as const },
      ],
    }
    expect(cardFaultsOf(several)).toEqual([
      { label: 'Dust bin missing', severity: 'error' },
      { label: 'Low temp', severity: 'warning' },
    ])
  })
})

describe('CardFaults row', () => {
  it('is hidden while unanswered and when empty', () => {
    const { rerender } = render(<CardFaults faults={cardFaultsOf(undefined)} />)
    expect(screen.queryByTestId('dc-faults')).toBeNull()
    rerender(<CardFaults faults={cardFaultsOf(slice(null))} />)
    expect(screen.queryByTestId('dc-faults')).toBeNull()
    rerender(<CardFaults faults={cardFaultsOf(slice(false))} />)
    expect(screen.queryByTestId('dc-faults')).toBeNull()
  })

  it('lists each fault as a chip', () => {
    render(
      <CardFaults
        faults={[
          { label: 'Dust bin missing', severity: 'error' },
          { label: 'Low temp', severity: 'warning' },
        ]}
      />,
    )
    const chips = screen.getAllByTestId('dc-fault')
    expect(chips.map((c) => c.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Dust bin missing'),
        expect.stringContaining('Low temp'),
      ]),
    )
    expect(chips).toHaveLength(2)
  })
})
