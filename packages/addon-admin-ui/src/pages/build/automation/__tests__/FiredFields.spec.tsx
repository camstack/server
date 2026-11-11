/**
 * The `device-fired` row: the choices are the device's own vocabulary, a
 * vocabulary not read yet never looks like "no events", and a pick writes one
 * button and one event.
 */
import type { DeviceFiredLeaf } from '@camstack/types'
import { selectOption } from '@camstack/ui-library/testing'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n/index'

interface SliceRead {
  status: 'pending' | 'error' | 'success'
  data: unknown
}
const read: { current: SliceRead; asked: Array<{ deviceId: number; enabled: boolean }> } = {
  current: { status: 'pending', data: undefined },
  asked: [],
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceStateGetCapSlice: (
      input: { deviceId: number; capName: string },
      options: { enabled: boolean },
    ) => {
      read.asked.push({ deviceId: input.deviceId, enabled: options.enabled })
      return read.current
    },
    DeviceValuePicker: (props: {
      readonly requires?: { readonly caps: readonly string[] }
      readonly onChange: (next: { deviceId: number } | null) => void
    }) => (
      <button
        type="button"
        data-testid="fake-device-picker"
        data-requires={props.requires?.caps.join(',')}
        onClick={() => props.onChange({ deviceId: 41 })}
      />
    ),
  }
})

import { FiredFields } from '../FiredFields'

const button = (n: string) => ({ id: n, label: `Button ${n}` })
const STATUS = {
  eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
  vocabulary: [
    { id: 'PRESS_SHORT', source: button('1'), label: 'Short press', kind: 'press' },
    { id: 'PRESS_LONG', source: button('1'), label: 'Long press', kind: 'long-press' },
    { id: 'PRESS_SHORT', source: button('2'), label: 'Short press', kind: 'press' },
  ],
  lastEvent: null,
  eventCountSinceStart: 0,
}
const LEAF: DeviceFiredLeaf = { kind: 'device-fired', deviceId: 40 }

let seen: DeviceFiredLeaf[] = []

function Harness({ initial }: { readonly initial: DeviceFiredLeaf }) {
  const [leaf, setLeaf] = useState(initial)
  return (
    <FiredFields
      leaf={leaf}
      onChange={(next) => {
        seen.push(next)
        setLeaf(next)
      }}
    />
  )
}

beforeEach(() => {
  seen = []
  read.asked = []
  read.current = { status: 'success', data: STATUS }
})

describe('FiredFields', () => {
  it('offers only devices that can fire, and asks for no vocabulary before one is picked', () => {
    render(<Harness initial={{ kind: 'device-fired', deviceId: 0 }} />)
    expect(screen.getByTestId('fake-device-picker').getAttribute('data-requires')).toBe(
      'event-emitter',
    )
    expect(read.asked.every((ask) => !ask.enabled)).toBe(true)
    expect(screen.queryByTestId('fired-event')).toBeNull()
  })

  it('a vocabulary not read yet says so and offers no event; a failed read is a warning, not "no events"', () => {
    read.current = { status: 'pending', data: undefined }
    const { unmount } = render(<Harness initial={LEAF} />)
    expect(screen.getByTestId('fired-vocabulary-pending')).toBeTruthy()
    expect(screen.queryByTestId('fired-event')).toBeNull()
    unmount()
    read.current = { status: 'error', data: undefined }
    render(<Harness initial={LEAF} />)
    expect(screen.getByTestId('fired-vocabulary-unknown')).toBeTruthy()
    expect(screen.queryByTestId('fired-event')).toBeNull()
  })

  it('picking a button then its event writes one source and one token', () => {
    render(<Harness initial={LEAF} />)
    selectOption(screen.getByTestId('fired-source'), '1')
    expect(seen.at(-1)).toEqual({ kind: 'device-fired', deviceId: 40, sourceIds: ['1'] })
    selectOption(screen.getByTestId('fired-event'), 'PRESS_LONG')
    expect(seen.at(-1)).toEqual({
      kind: 'device-fired',
      deviceId: 40,
      sourceIds: ['1'],
      eventIds: ['PRESS_LONG'],
    })
  })

  it('another device clears the button and the event', () => {
    render(<Harness initial={{ ...LEAF, sourceIds: ['1'], eventIds: ['PRESS_LONG'] }} />)
    fireEvent.click(screen.getByTestId('fake-device-picker'))
    expect(seen.at(-1)).toEqual({ kind: 'device-fired', deviceId: 41 })
  })

  it('a pick the device no longer declares stays on screen with a warning', () => {
    render(<Harness initial={{ ...LEAF, sourceIds: ['9'] }} />)
    expect(screen.getByTestId('fired-stale')).toBeTruthy()
  })

  it('filters written outside the editor are shown as kept', () => {
    render(<Harness initial={{ ...LEAF, kinds: ['long-press'] }} />)
    expect(screen.getByTestId('fired-extra').textContent).toContain('long-press')
  })
})
