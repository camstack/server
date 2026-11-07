import { DeviceType } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { CompositionFieldsFeature } from '@camstack/types'
import {
  DISHWASHER,
  SWITCH_REF,
} from '../../../../../../../types/src/composition/customize/__fixtures__/refs.js'
import { CUSTOMIZE_STORED_CASES } from '../../../../../../../types/src/composition/customize/__fixtures__/stored-cases.js'

const HOST = {
  id: 501,
  name: 'Kitchen dishwasher',
  addonId: DISHWASHER.addonId,
  stableId: DISHWASHER.stableId,
  type: DeviceType.Dishwasher,
  location: 'Kitchen',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const METER = {
  id: 305,
  name: 'Porch power meter',
  addonId: SWITCH_REF.addonId,
  stableId: SWITCH_REF.stableId,
  type: 'sensor',
  location: 'Kitchen',
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const GARAGE = {
  ...METER,
  id: 304,
  name: 'Garage lamp',
  stableId: 'lamp',
  location: 'Garage',
}

const proposalResult = vi.hoisted(() => ({
  current: { status: 'pending' } as { status: string; data?: unknown },
}))

const fleet = vi.hoisted(() => ({
  current: { status: 'pending' } as { status: string; data?: unknown[] },
}))

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known' as const,
    value: new Map<number, readonly string[]>([[305, ['power-meter']]]),
  }),
}))

// The REAL DeviceValueField and DevicePicker run here (the compact card is the subject);
// only the system provider their zone grouping reads is faked.
vi.mock('../../../../../../../ui-library/src/contexts/system-context', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCoreBlocksProposeRunningThreshold: () => proposalResult.current,
    useDeviceManagerListAll: () => fleet.current,
    useDeviceManagerGetWireableFields: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: {
              caps: [
                {
                  cap: 'power-meter',
                  fields: [{ path: 'power', kind: 'number' as const }],
                },
              ],
            },
          }
        : { status: 'success' as const, data: { caps: [] } },
    useDeviceStateGetSnapshot: ({ deviceId }: { deviceId: number }) =>
      deviceId === 305
        ? {
            status: 'success' as const,
            data: { 'power-meter': { power: 8.4, unit: 'W' } },
          }
        : { status: 'success' as const, data: {} },
  }
})

const { ScalarOverrideDialog } = await import('../ScalarOverrideDialog')

function dialog(seeded = true) {
  return (
    <ScalarOverrideDialog
      open
      mode={seeded ? 'change' : 'add'}
      title="Running"
      cap="running-state"
      targetId="running"
      host={HOST}
      target={DISHWASHER}
      apply={seeded ? 'replace' : 'add'}
      seed={
        !seeded
          ? null
          : {
              source: {
                addonId: METER.addonId,
                stableId: METER.stableId,
                cap: 'power-meter',
                fieldPath: 'power',
                valueKind: 'number',
                sourceUnit: 'W',
                changedAtField: null,
              },
              transform: {
                kind: 'threshold',
                comparison: 'gte',
                threshold: 7,
                startDwellMs: 90_000,
                stopDwellMs: 600_000,
              },
            }
      }
      canSave
      onClose={() => undefined}
      onSave={() => undefined}
    />
  )
}

function renderPhone(ui: ReactElement) {
  window.matchMedia = ((query: string) => ({
    matches: query === '(max-width: 639px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  )
  const view = render(wrap(ui))
  return { rerender: (node: ReactElement) => view.rerender(wrap(node)) }
}

const mode = () => screen.getByTestId('source-selector').getAttribute('data-mode')

describe('ScalarOverrideDialog change mode on a phone, fleet answering after mount', () => {
  it('shows the compact card with the editable threshold fields once the seeded device resolves', () => {
    proposalResult.current = { status: 'pending' }
    fleet.current = { status: 'pending' }
    const { rerender } = renderPhone(dialog())
    fleet.current = { status: 'success', data: [HOST, METER] }
    rerender(dialog())
    expect(mode()).toBe('card')
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('source-selector-back')).toBeNull()
    expect(screen.getByTestId('source-selector-source').textContent).toContain('Porch power meter')
  })

  it('draws the proposal inside the card and Apply fills the threshold field', () => {
    proposalResult.current = {
      status: 'success',
      data: {
        state: 'proposal',
        transform: {
          kind: 'threshold',
          comparison: 'gte',
          threshold: 11,
          startDwellMs: 90_000,
          stopDwellMs: 600_000,
        },
        confidence: 'high',
        notes: [],
        evidence: { spanMs: 14 * 86_400_000, runsFound: 9 },
      },
    }
    fleet.current = { status: 'success', data: [HOST, METER] }
    renderPhone(dialog())
    const card = screen.getByTestId('source-selector')
    expect(card.contains(screen.getByTestId('running-proposal'))).toBe(true)
    fireEvent.click(screen.getByTestId('running-proposal-apply'))
    expect(
      screen.getAllByRole('spinbutton').some((el) => (el as HTMLInputElement).value === '11'),
    ).toBe(true)
  })

  it('create mode starts with the device list, not a card', () => {
    proposalResult.current = { status: 'pending' }
    fleet.current = { status: 'success', data: [HOST, METER] }
    renderPhone(dialog(false))
    expect(mode()).toBe('picker')
    expect(screen.getByText('Porch power meter')).toBeTruthy()
  })
})
