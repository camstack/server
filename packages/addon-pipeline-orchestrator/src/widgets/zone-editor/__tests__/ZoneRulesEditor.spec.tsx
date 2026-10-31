// @vitest-environment jsdom
/**
 * Saving zone rules goes through the zone-rules cap with an explicit
 * deviceId, also when the device proxy carries no `zoneRules` entry (a
 * cluster singleton has no per-device binding), and a rejected save is shown.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Zone } from '@camstack/types'

const hoisted = vi.hoisted(() => ({
  setRules: vi.fn(),
  slice: { motion: [], detection: [], package: [] },
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useSystem: () => ({ trpcClient: { zoneRules: { setRules: { mutate: hoisted.setRules } } } }),
    useDeviceStateSlice: () => hoisted.slice,
    BTN_COMPACT: '',
    BTN_COMPACT_PRIMARY: '',
    CHIP_BASE: '',
    CHIP_ACTIVE: '',
    CHIP_INACTIVE: '',
    INPUT_COMPACT: '',
    TEXT_SECTION_LABEL: '',
  }
})
vi.mock('../../../i18n/index.js', () => ({
  useT: () => ({ t: (key: string) => key }),
  translate: (key: string) => key,
}))

import { ZoneRulesEditor } from '../ZoneRulesEditor'

const ZONES: readonly Zone[] = [
  {
    id: 'z1',
    name: 'Yard',
    kind: 'polygon',
    color: '#000000',
    polygon: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  },
]

// A device proxy of a camera with no `zone-rules` binding entry.
const DEV = { state: { zoneRules: {} } } as never

describe('ZoneRulesEditor save', () => {
  beforeEach(() => {
    hoisted.setRules.mockReset()
  })
  afterEach(cleanup)

  it('saves through the cap with the deviceId when the proxy has no zoneRules', async () => {
    hoisted.setRules.mockResolvedValue(undefined)
    render(<ZoneRulesEditor dev={DEV} deviceId={7} stage="motion" zones={ZONES} />)
    fireEvent.click(screen.getByTitle('rules.add'))
    fireEvent.click(screen.getByText('rules.save'))
    await waitFor(() => expect(hoisted.setRules).toHaveBeenCalledTimes(1))
    const sent = hoisted.setRules.mock.calls[0]?.[0] as { deviceId: number; stage: string }
    expect(sent.deviceId).toBe(7)
    expect(sent.stage).toBe('motion')
  })

  it('shows the error when the save is rejected', async () => {
    hoisted.setRules.mockRejectedValue(new Error('zoneRules: boom'))
    render(<ZoneRulesEditor dev={DEV} deviceId={7} stage="motion" zones={ZONES} />)
    fireEvent.click(screen.getByTitle('rules.add'))
    fireEvent.click(screen.getByText('rules.save'))
    await waitFor(() => expect(hoisted.setRules).toHaveBeenCalledTimes(1))
    expect((await screen.findByText(/boom/)).tagName).toBe('P')
  })
})
