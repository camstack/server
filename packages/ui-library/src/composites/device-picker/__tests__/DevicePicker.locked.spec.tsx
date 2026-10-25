/**
 * Locked devices: ones already part of what the picker edits (linked to the
 * camera, assigned to the room). They are drawn checked and disabled and are
 * never emitted, not even by a group's "All".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

import { DevicePicker } from '../DevicePicker'
import type { PickerDevice } from '../device-picker-model'

const DEVICES: readonly PickerDevice[] = [
  { id: 1, name: 'Porch light', type: 'light', location: 'Hall' },
  { id: 2, name: 'Gate contact', type: 'light', location: 'Hall' },
  { id: 3, name: 'Lamp', type: 'light', location: 'Hall' },
]

function wrap(node: ReactElement): ReactElement {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

function box(id: number): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[data-device-id="${String(id)}"]`)
  if (el === null) throw new Error(`no checkbox for ${String(id)}`)
  return el
}

describe('DevicePicker lockedIds', () => {
  it('draws a locked device checked, disabled and noted, and never selects it', () => {
    const onChange = vi.fn()
    render(
      wrap(
        <DevicePicker
          devices={DEVICES}
          listState="answered"
          value={[]}
          onChange={onChange}
          noun="device"
          showAll
          lockedIds={[1]}
          lockedNote="Already linked"
        />,
      ),
    )
    expect(box(1).checked).toBe(true)
    expect(box(1).disabled).toBe(true)
    expect(screen.getByText('Already linked')).toBeTruthy()
    expect(box(2).checked).toBe(false)
    fireEvent.click(box(2))
    expect(onChange).toHaveBeenLastCalledWith([2])
  })

  it('a group "All" does not emit the locked ids', () => {
    const onChange = vi.fn()
    render(
      wrap(
        <DevicePicker
          devices={DEVICES}
          listState="answered"
          value={[]}
          onChange={onChange}
          noun="device"
          showAll
          lockedIds={[1]}
        />,
      ),
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'All' })[0] as HTMLElement)
    const emitted = onChange.mock.calls.at(-1)?.[0] as number[]
    expect(emitted).not.toContain(1)
    expect(emitted).toEqual(expect.arrayContaining([2, 3]))
  })
})
