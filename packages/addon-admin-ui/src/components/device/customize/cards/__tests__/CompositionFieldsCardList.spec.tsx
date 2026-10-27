/**
 * Generic composition cards read like declared ones: vocabulary titles,
 * device names, and the same Change / Remove / + Add actions.
 */
import { DeviceRole, DeviceType, type Composition, type DeviceInfo } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { PORCH_COMPOSITION } from '../../../../../../../types/src/composition/cards/__fixtures__/stored-compositions'
import { buildSkeletonComposition } from '../../../../composition-editor/build-skeleton'
import { eventCardTargets } from '../../event/event-targets'
import { keyedArrayCardTargets } from '../../keyed/KeyedArrayCard'
import { scalarCardTargets } from '../../scalar/ScalarOverrideCard'
import { presentState } from '../../kinds/__tests__/customization-fixture'
import { type CustomizationHandle, type CustomizationSaveOutcome } from '../../use-customization'

vi.mock('@camstack/ui-library', () => ({
  Badge: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    readonly children?: ReactNode
    readonly onClick?: () => void
    readonly disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Dialog: ({ children, open }: { readonly children?: ReactNode; readonly open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogBody: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Dropdown: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DropdownTrigger: ({
    children,
    ...rest
  }: {
    readonly children?: ReactNode
    readonly 'data-testid'?: string
  }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  DropdownContent: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DropdownItem: ({ children }: { readonly children?: ReactNode }) => (
    <button type="button" role="menuitem">
      {children}
    </button>
  ),
  Select: () => null,
  SectionCard: ({
    title,
    children,
    testId,
  }: {
    readonly title: string
    readonly children?: ReactNode
    readonly testId?: string
  }) => (
    <section data-testid={testId}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  useDeviceLabel: (device: { readonly name: string }) => device.name,
}))

vi.mock('../../use-confirm-remove', () => ({
  useConfirmRemove: () => async () => true,
}))

const fleet = vi.hoisted(
  (): { current: readonly { addonId: string; stableId: string; name: string }[] } => ({
    current: [],
  }),
)

vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({ kind: 'known' as const, value: fleet.current }),
}))

vi.mock('../../source-selector/SourceSelector', () => ({
  SourceSelector: () => null,
}))

vi.mock('../../../../composition-editor/LivePreview', () => ({ LivePreview: () => null }))

vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: () => ({ kind: 'absent' }),
}))

const { CompositionFieldsCardList } = await import('../CompositionFieldsCardList')

const DEVICE = {
  id: 4603,
  stableId: 'composed-blk-porch',
  addonId: 'composer',
  type: DeviceType.Sensor,
  name: 'Porch (composto)',
  location: 'Porch',
  disabled: false,
  parentDeviceId: null,
  role: 'temperature-sensor',
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
} satisfies DeviceInfo

function nameFor(stableId: string): string {
  if (stableId.includes('termostato')) return 'Porch thermostat'
  if (stableId.includes('clima_porch')) return 'Porch climate'
  if (stableId.includes('movimento')) return 'Porch motion'
  if (stableId.includes('mac-')) return 'Porch camera'
  return 'Named device'
}

function fleetOf(composition: Composition): void {
  const rows: { addonId: string; stableId: string; name: string }[] = []
  for (const feature of composition.features) {
    if (feature.kind !== 'fields') continue
    for (const source of Object.values(feature.fields)) {
      if (source.kind !== 'expression') continue
      for (const binding of Object.values(source.bindings)) {
        if (binding.kind !== 'from') continue
        rows.push({
          addonId: binding.source.addonId,
          stableId: binding.source.stableId,
          name: nameFor(binding.source.stableId),
        })
      }
    }
  }
  fleet.current = rows
}

function handleOf(composition: Composition): CustomizationHandle {
  return {
    target: { addonId: DEVICE.addonId, stableId: DEVICE.stableId },
    state: presentState(composition),
    saving: false,
    save: async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({
      kind: 'saved',
    }),
  }
}

describe('CompositionFieldsCardList', () => {
  it('reads Porch with vocabulary labels, device names, and words for transforms', () => {
    fleetOf(PORCH_COMPOSITION)
    render(
      <CompositionFieldsCardList
        device={DEVICE}
        handle={handleOf(PORCH_COMPOSITION)}
        skipCaps={new Set()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Temperature' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Binary sensor' })).toBeTruthy()
    expect(screen.getByText('Temperature (°C)')).toBeTruthy()
    expect(screen.getByText('From Porch thermostat · Temperature (°C)')).toBeTruthy()
    expect(screen.getByText('From Porch climate · Temperature (°C)')).toBeTruthy()
    expect(screen.getByText('average, 1 decimal')).toBeTruthy()
    expect(screen.getByText('Last update')).toBeTruthy()
    expect(screen.getByText('latest')).toBeTruthy()
    expect(screen.getByText('On')).toBeTruthy()
    expect(screen.getByText('Last change')).toBeTruthy()
    expect(screen.getByText('now')).toBeTruthy()
    expect(screen.getAllByText('Formula').length).toBeGreaterThan(0)
    expect(screen.getByText(/Porch motion · Motion/)).toBeTruthy()
    expect(screen.getByText(/Porch camera · Motion/)).toBeTruthy()
    expect(screen.getAllByText(/within 5 min/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Remove the Temperature feature' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove the Binary sensor feature' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('300000')
    expect(text).not.toContain('TEMPERATURE-SENSOR')
    expect(text).not.toContain('temperature-sensor')
    expect(text).not.toContain('avg-round-1')
    expect(text).not.toContain('ha:ha_001')
    expect(text).not.toContain('celsius')
    expect(text).not.toContain('lastChangedAt')
    expect(screen.queryByRole('button', { name: 'Room' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Derived binary' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Change' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0)
  })

  it('marks a new role card required field to fill and offers + Add', () => {
    fleet.current = []
    const composition = buildSkeletonComposition({
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
    if (composition === null) throw new Error('skeleton')
    render(
      <CompositionFieldsCardList
        device={DEVICE}
        handle={handleOf(composition)}
        skipCaps={new Set()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Temperature' })).toBeTruthy()
    expect(screen.getByText('Temperature (°C)')).toBeTruthy()
    expect(screen.getByText('To fill')).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ Add override' })).toBeTruthy()
  })

  it('keeps the generic card when the cap opts into Advanced without a card target', () => {
    const skip = new Set<string>()
    for (const { cap } of scalarCardTargets()) skip.add(cap)
    for (const { cap } of keyedArrayCardTargets()) skip.add(cap)
    for (const { cap } of eventCardTargets()) skip.add(cap)
    expect(skip.has('temperature-sensor')).toBe(false)
    expect(skip.has('binary')).toBe(false)
    fleet.current = []
    const composition = buildSkeletonComposition({
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
    if (composition === null) throw new Error('skeleton')
    render(
      <CompositionFieldsCardList device={DEVICE} handle={handleOf(composition)} skipCaps={skip} />,
    )
    expect(screen.getByRole('heading', { name: 'Temperature' })).toBeTruthy()
  })
})
