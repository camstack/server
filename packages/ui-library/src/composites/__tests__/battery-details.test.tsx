// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BatteryBadge } from '../battery-badge'
import { batteryDetailRows } from '../battery-details'

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const base = { level: 80, charging: 'unknown', sleeping: false } as const
const ids = (rows: ReturnType<typeof batteryDetailRows>): string[] => rows.map((r) => r.id)

describe('batteryDetailRows', () => {
  it('hides every unknown fact — only the always-known sleep state remains', () => {
    const rows = batteryDetailRows(
      { ...base, chargeState: 'unknown', voltage: null, currentMa: null, temperatureC: null },
      NOW,
    )
    expect(ids(rows)).toEqual(['sleep'])
  })

  it('keeps a measured 0 (a real reading) but hides null', () => {
    const rows = batteryDetailRows({ ...base, currentMa: 0, voltage: null }, NOW)
    expect(ids(rows)).toEqual(['current', 'sleep'])
  })

  it('maps charging, full and idle to distinct phrases', () => {
    const phrase = (chargeState: 'charging' | 'full' | 'idle'): unknown =>
      batteryDetailRows({ ...base, chargeState }, NOW).find((r) => r.id === 'cell')?.value
    expect(phrase('charging')).toEqual({ kind: 'phrase', phrase: 'charging' })
    expect(phrase('full')).toEqual({ kind: 'phrase', phrase: 'full' })
    expect(phrase('idle')).toEqual({ kind: 'phrase', phrase: 'notCharging' })
  })

  it('names the power source and formats numbers with units', () => {
    const rows = batteryDetailRows(
      { ...base, charging: 'solar', voltage: 3.921, currentMa: 120, temperatureC: 24.26 },
      NOW,
    )
    expect(rows.map((r) => r.value)).toEqual([
      { kind: 'phrase', phrase: 'solar' },
      { kind: 'number', text: '3.92 V' },
      { kind: 'number', text: '120 mA' },
      { kind: 'number', text: '24.26 °C' },
      { kind: 'phrase', phrase: 'awake' },
    ])
  })

  it('reports last contact relative to now and ignores placeholder stamps', () => {
    const at = (lastContactAt: number): unknown =>
      batteryDetailRows({ ...base, lastContactAt }, NOW).find((r) => r.id === 'lastContact')?.value
    expect(at(NOW - 5 * 60_000)).toEqual({ kind: 'ago', unit: 'minutes', count: 5 })
    expect(at(NOW - 3 * 3_600_000)).toEqual({ kind: 'ago', unit: 'hours', count: 3 })
    expect(at(1)).toBeUndefined()
  })
})

describe('BatteryBadge full variant', () => {
  it('opens a details popover with only known facts', () => {
    render(
      <BatteryBadge
        variant="full"
        status={{ ...base, charging: 'dc', chargeState: 'full', temperatureC: 21, sleeping: true }}
      />,
    )
    fireEvent.click(screen.getByLabelText('Battery details'))
    expect(screen.getByText('Mains')).not.toBeNull()
    expect(screen.getByText('Full')).not.toBeNull()
    expect(screen.getByText('21 °C')).not.toBeNull()
    expect(screen.getByText('Asleep')).not.toBeNull()
    expect(screen.queryByText('Voltage')).toBeNull()
  })

  it('compact variant has no details trigger', () => {
    render(<BatteryBadge status={{ ...base, chargeState: 'charging' }} />)
    expect(screen.queryByLabelText('Battery details')).toBeNull()
  })
})
