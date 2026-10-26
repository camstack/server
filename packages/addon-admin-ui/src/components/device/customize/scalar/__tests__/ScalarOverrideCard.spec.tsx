import {
  type Composition,
  type CustomizeCatalogTarget,
  DeviceType,
  CAP_CUSTOMIZE_CATALOG,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

vi.mock('../../../../composition-editor/LivePreview', () => ({ LivePreview: () => null }))
import type { CandidateDevice } from '../../assignments/assignment-candidates'
import type { Known } from '../../known'
import type { CustomizationHandle } from '../../use-customization'
import { presentState } from '../../kinds/__tests__/customization-fixture'
import { scalarFeatureFromForm } from '../scalar-form'

const DEVICE = {
  id: 4127,
  name: 'PetKit',
  addonId: 'provider-homeassistant',
  stableId: 'ha:feeder',
  type: DeviceType.PetFeeder,
  location: 'Kitchen',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const TARGET = { addonId: DEVICE.addonId, stableId: DEVICE.stableId }
const SENSOR = { addonId: 'provider-homeassistant', stableId: 'sensor.battery' }
const SENSOR_DEVICE: CandidateDevice = {
  id: 9,
  name: 'Garage sensor',
  addonId: SENSOR.addonId,
  stableId: SENSOR.stableId,
  type: 'sensor',
  location: 'Kitchen',
  isCamera: false,
  integration: 'Home Assistant',
}

const confirm = vi.hoisted(() => ({ answer: true }))
const devices = vi.hoisted((): { current: Known<readonly CandidateDevice[]> } => ({
  current: { kind: 'pending' },
}))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => async () => confirm.answer,
    useDeviceManagerGetWireableFields: () => ({ status: 'pending', data: undefined }),
    useDeviceStateGetSnapshot: () => ({ status: 'pending', data: undefined }),
  }
})
vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => devices.current,
}))
vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: () => ({ kind: 'value', value: 73 }),
}))
vi.mock('../ScalarOverrideDialog', () => ({
  ScalarOverrideDialog: () => null,
}))

const { ScalarOverrideCard } = await import('../ScalarOverrideCard')

function targetOf(cap: 'battery' | 'running-state'): CustomizeCatalogTarget {
  const found = CAP_CUSTOMIZE_CATALOG[cap].targets[0]
  if (found === undefined) throw new Error(cap)
  return found
}

function handleOf(
  state: CustomizationHandle['state'],
  save = vi.fn(async () => ({ kind: 'saved' as const })),
): CustomizationHandle {
  return { target: TARGET, state, saving: false, save }
}

function batteryFeature(apply: 'add' | 'replace'): Composition['features'][number] {
  const feature = scalarFeatureFromForm({
    cap: 'battery',
    targetId: 'percentage',
    device: TARGET,
    apply,
    source: {
      addonId: SENSOR.addonId,
      stableId: SENSOR.stableId,
      cap: 'numeric-sensor',
      fieldPath: 'value',
      valueKind: 'number',
      sourceUnit: null,
      changedAtField: null,
    },
    transform: { kind: 'identity' },
  })
  if (feature === null) throw new Error('feature')
  return feature
}

beforeEach(() => {
  confirm.answer = true
  devices.current = { kind: 'known', value: [SENSOR_DEVICE] }
})

describe('ScalarOverrideCard', () => {
  it('pending availability says it is checking and offers no add', () => {
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf({ kind: 'none' })}
        availability={{ kind: 'pending' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(screen.getByRole('status').textContent).toMatch(/Checking capabilities/)
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull()
  })

  it('a native card shows the effective value, Native, and add', () => {
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf({ kind: 'none' })}
        availability={{ kind: 'present', mode: 'add' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(screen.getByText('Native')).toBeTruthy()
    expect(screen.getByText('73 %')).toBeTruthy()
    expect(screen.getByText('Not added')).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ Add' })).toBeTruthy()
  })

  it('an assigned source is named and removable', async () => {
    const feature = batteryFeature('add')
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [feature],
    }
    const handle = handleOf(presentState(composition))
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handle}
        availability={{ kind: 'present', mode: 'add' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(screen.getByText('Assigned · Garage sensor')).toBeTruthy()
    expect(screen.getByText(/Source: Garage sensor/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(handle.save).toHaveBeenCalledWith(null))
  })

  it('another formula opens the formula dialog and is not removed', () => {
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: { percentage: { kind: 'expression', expr: 'x * 2', bindings: {} } },
        },
      ],
    }
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
        this.open = true
      }
    }
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf(presentState(composition))}
        availability={{ kind: 'present', mode: 'add' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Formula$/ }))
    expect(screen.getByTestId('formula-dialog')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('a replaced battery whose source device is gone says the source is missing', () => {
    devices.current = { kind: 'known', value: [] }
    const feature = batteryFeature('replace')
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [feature],
    }
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf(presentState(composition))}
        availability={{ kind: 'present', mode: 'add' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(screen.getByText('Native · source missing')).toBeTruthy()
    expect(screen.getByText(/no longer exists/)).toBeTruthy()
    expect(screen.queryByText(SENSOR.stableId)).toBeNull()
  })

  it('does not name a source by its raw key while the fleet is unread', () => {
    devices.current = { kind: 'pending' }
    const feature = batteryFeature('add')
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [feature],
    }
    render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf(presentState(composition))}
        availability={{ kind: 'present', mode: 'add' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(screen.queryByText(SENSOR.stableId)).toBeNull()
    expect(screen.getByText('pending')).toBeTruthy()
  })

  it('hides a card whose declaration excludes this device type', () => {
    const running = { ...targetOf('running-state'), deviceTypes: [DeviceType.Dishwasher] }
    const { container } = render(
      <ScalarOverrideCard
        device={{ ...DEVICE, type: DeviceType.Camera }}
        handle={handleOf({ kind: 'none' })}
        availability={{ kind: 'present', mode: 'add' }}
        cap="running-state"
        target={running}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('shows running when the declaration names this device type', () => {
    const running = { ...targetOf('running-state'), deviceTypes: [DeviceType.Dishwasher] }
    render(
      <ScalarOverrideCard
        device={{ ...DEVICE, type: DeviceType.Dishwasher, name: 'Kitchen dishwasher' }}
        handle={handleOf({ kind: 'none' })}
        availability={{ kind: 'present', mode: 'add' }}
        cap="running-state"
        target={running}
      />,
    )
    expect(screen.getByRole('button', { name: '+ Add' })).toBeTruthy()
  })

  it('is absent only after applicability answered no', () => {
    const { container } = render(
      <ScalarOverrideCard
        device={DEVICE}
        handle={handleOf({ kind: 'none' })}
        availability={{ kind: 'absent' }}
        cap="battery"
        target={targetOf('battery')}
      />,
    )
    expect(container.textContent).toBe('')
  })
})
