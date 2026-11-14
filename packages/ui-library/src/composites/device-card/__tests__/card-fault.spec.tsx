// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mockupCommon } from '../__fixtures__/common'
import { CardTop } from '../shell/DeviceCard'
import { type CardCommon, cardFaultOf } from '../shell/model'

afterEach(cleanup)

const base: CardCommon = {
  ...mockupCommon({
    name: 'Robot',
    integration: 'Dreame',
    watts: 0,
    supplyName: 'Socket',
    consumables: [],
    remote: [],
  }),
}

const slice = (active: boolean | null) => ({
  active,
  code: '38',
  label: 'Dust bin missing',
  severity: 'error' as const,
})

describe('cardFaultOf — only an answered `active: true` is a fault', () => {
  it('draws nothing for an absent cap, an unread slice and a clear one', () => {
    expect(cardFaultOf(undefined)).toBeNull()
    expect(cardFaultOf(slice(null))).toBeNull()
    expect(cardFaultOf(slice(false))).toBeNull()
  })

  it('returns the label and severity for an active fault', () => {
    expect(cardFaultOf(slice(true))).toEqual({ label: 'Dust bin missing', severity: 'error' })
  })
})

describe('CardTop fault badge', () => {
  it('renders the badge only when the device reports a fault', () => {
    const { rerender } = render(<CardTop common={{ ...base, fault: null }} />)
    expect(screen.queryByTestId('dc-fault')).toBeNull()

    rerender(<CardTop common={{ ...base, fault: cardFaultOf(slice(false)) }} />)
    expect(screen.queryByTestId('dc-fault')).toBeNull()

    rerender(<CardTop common={{ ...base, fault: cardFaultOf(slice(true)) }} />)
    expect(screen.getByTestId('dc-fault').textContent).toContain('Dust bin missing')
  })

  it('shows the badge on a card with no integration chip and a reachable device', () => {
    render(<CardTop common={{ ...base, integration: null, fault: cardFaultOf(slice(true)) }} />)
    expect(screen.getByTestId('dc-fault')).toBeTruthy()
  })
})
