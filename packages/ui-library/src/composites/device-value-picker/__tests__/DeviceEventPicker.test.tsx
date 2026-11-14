// @vitest-environment jsdom
/**
 * The device picker's event mode: a device, then its parts and events on a
 * second page; several picks of several devices are chips in the closed field;
 * a vocabulary that has not answered never reads as "no event" (D315).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceFiredEntry } from '../device-event-model'

const source = (id: string) => ({ id, label: `Button ${id}` })
const VOCABULARY = ['1', '2'].flatMap((id) => [
  { id: 'press_short', source: source(id), label: 'Short press', kind: 'press' },
  { id: 'press_long', source: source(id), label: 'Long press', kind: 'long-press' },
])
const slice = { status: 'success' as 'success' | 'pending', data: undefined as unknown }

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceStateGetCapSlice: () => ({ status: slice.status, data: slice.data }),
}))
vi.mock('../device-value-panel', () => ({
  DeviceValuePanel: (props: { readonly onSelect: (v: { deviceId: number }) => void }) => (
    <button
      type="button"
      data-testid="pick-device"
      onClick={() => props.onSelect({ deviceId: 1 })}
    />
  ),
}))

const { DeviceEventPicker } = await import('../DeviceEventPicker')
const { DeviceFleetProvider } = await import('../../device-name/device-fleet')

const FLEET = [
  { id: 1, name: 'Buttons', type: 'event-emitter', stableId: 's1', parentDeviceId: 10 },
  { id: 10, name: 'Wall switch', type: 'container', stableId: 's10', parentDeviceId: null },
]

function Harness({
  start,
  onValue,
}: {
  readonly start: readonly DeviceFiredEntry[]
  readonly onValue: (next: readonly DeviceFiredEntry[]) => void
}): ReactNode {
  const [value, setValue] = useState(start)
  return (
    <DeviceFleetProvider devices={FLEET}>
      <DeviceEventPicker
        testId="events"
        value={value}
        onChange={(next) => {
          setValue(next)
          onValue(next)
        }}
      />
    </DeviceFleetProvider>
  )
}

beforeEach(() => {
  slice.status = 'success'
  slice.data = {
    eventTypes: ['press_short', 'press_long'],
    vocabulary: VOCABULARY,
    lastEvent: null,
    eventCountSinceStart: 0,
  }
})
afterEach(cleanup)

describe('DeviceEventPicker', () => {
  it('picks a device, then several of its events, and can go back to the devices', () => {
    const onValue = vi.fn()
    render(<Harness start={[]} onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: /add event/i }))
    fireEvent.click(screen.getByTestId('pick-device'))
    const first = screen.getByRole('group', { name: 'Button 1' })
    const second = screen.getByRole('group', { name: 'Button 2' })
    fireEvent.click(first.querySelectorAll('input')[0] ?? document.body)
    fireEvent.click(second.querySelectorAll('input')[1] ?? document.body)
    // Each pick is a whole device-fired leaf with its own id.
    const leaves = onValue.mock.lastCall?.[0] as readonly DeviceFiredEntry[]
    expect(leaves).toEqual([
      {
        kind: 'device-fired',
        id: expect.stringMatching(/^ev-/),
        deviceId: 1,
        sourceIds: ['1'],
        eventIds: ['press_short'],
      },
      {
        kind: 'device-fired',
        id: expect.stringMatching(/^ev-/),
        deviceId: 1,
        sourceIds: ['2'],
        eventIds: ['press_long'],
      },
    ])
    expect(leaves[0]?.id).not.toBe(leaves[1]?.id)
    fireEvent.click(first.querySelectorAll('input')[0] ?? document.body)
    expect(onValue.mock.lastCall?.[0]).toEqual([leaves[1]])
    fireEvent.click(screen.getByRole('button', { name: /back to devices/i }))
    expect(screen.getByTestId('pick-device')).toBeTruthy()
  })

  it('reads a pick as "device · part · event", the device named with its parent', () => {
    render(
      <Harness
        start={[
          {
            kind: 'device-fired',
            id: 'ev-a',
            deviceId: 1,
            sourceIds: ['1'],
            eventIds: ['press_short'],
          },
        ]}
        onValue={vi.fn()}
      />,
    )
    const text = screen.getByTestId('events').textContent ?? ''
    expect(text).toContain('Wall switch')
    expect(text).toContain('Button 1 · Short press')
  })

  it('never says a device fires nothing before its vocabulary answered', () => {
    slice.status = 'pending'
    render(<Harness start={[]} onValue={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /add event/i }))
    fireEvent.click(screen.getByTestId('pick-device'))
    expect(screen.getByTestId('dep-events').textContent).toContain('Reading what this device')
    expect(screen.getByTestId('dep-events').textContent).not.toContain('declares no event')
  })
})
