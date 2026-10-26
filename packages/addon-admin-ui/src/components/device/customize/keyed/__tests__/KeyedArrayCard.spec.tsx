/**
 * The keyed-array card shows native items beside assigned ones. Add is only
 * offered when the capability is still assignable; an item the compiler did
 * not write is left in place and opens Advanced.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type ConsumableItem,
  DeviceType,
  compileKeyedArrayOverride,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

vi.mock('../../../../composition-editor/LivePreview', () => ({ LivePreview: () => null }))
import type { Known } from '../../known'
import type { DefaultConsumable } from '../../default-consumables'
import type { CustomizationHandle, CustomizationSaveOutcome } from '../../use-customization'
import { presentState } from '../../kinds/__tests__/customization-fixture'
import { KeyedArrayCard } from '../KeyedArrayCard'

const HOST = {
  id: 501,
  name: 'Kitchen dishwasher',
  addonId: 'bosch-home-connect',
  stableId: 'appliance-501',
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
const TARGET = { addonId: HOST.addonId, stableId: HOST.stableId }
const METER = { addonId: 'provider-homeassistant', stableId: 'sensor.salt' }

const confirm = vi.hoisted((): { answer: boolean } => ({ answer: true }))
const dialogStub = vi.hoisted(() => ({
  key: 'brine',
  feature: null as CompositionFieldsFeature | null,
}))
vi.mock('../KeyedArrayItemDialog', () => ({
  KeyedArrayItemDialog: (props: {
    readonly open: boolean
    readonly onSave: (feature: CompositionFieldsFeature, key: string) => void
  }) =>
    props.open ? (
      <button
        type="button"
        data-testid="keyed-save-item"
        onClick={() => {
          if (dialogStub.feature !== null) props.onSave(dialogStub.feature, dialogStub.key)
        }}
      >
        Save item
      </button>
    ) : null,
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
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      {
        id: 80,
        name: 'Salt sensor',
        addonId: METER.addonId,
        stableId: METER.stableId,
        type: 'sensor',
        location: 'Kitchen',
        isCamera: false,
        integration: null,
      },
    ],
  }),
}))
vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: () => ({ kind: 'value', value: 40 }),
}))

const SALT: ConsumableItem = {
  key: 'salt',
  label: 'Salt',
  level: 80,
  status: 'ok',
  kind: 'supply',
  form: 'tank',
  lastResetAt: null,
  resettable: false,
}
const NATIVE: Known<readonly DefaultConsumable[]> = {
  kind: 'known',
  value: [{ kind: 'item', key: 'salt', item: SALT }],
}
const NONE: Known<readonly DefaultConsumable[]> = { kind: 'known', value: [] }

function featureOf(key: string) {
  return compileKeyedArrayOverride({
    cap: 'consumables',
    targetId: 'items',
    device: TARGET,
    apply: 'add',
    items: [
      {
        draft: {
          kind: 'keyedArray',
          cap: 'consumables',
          targetId: 'items',
          key,
          label: 'Filter',
          fieldPath: 'level',
          source: { ...METER, cap: 'numeric-sensor', fieldPath: 'value' },
          transform: { kind: 'identity' },
        },
        sourceValueKind: 'number',
        sourceUnit: null,
        literals: [
          { path: 'kind', value: 'wear' },
          { path: 'form', value: 'part' },
        ],
      },
    ],
  })
}

function handleOf(composition: Composition | null): CustomizationHandle {
  const state = composition === null ? ({ kind: 'none' } as const) : presentState(composition)
  return {
    target: TARGET,
    state,
    saving: false,
    save: vi.fn(async () => ({ kind: 'saved' as const })),
  }
}

beforeEach(() => {
  confirm.answer = true
  const brine = featureOf('brine')
  if (!brine.ok) throw new Error(brine.reason)
  dialogStub.key = 'brine'
  dialogStub.feature = brine.value
})

describe('KeyedArrayCard', () => {
  const target = CAP_CUSTOMIZE_CATALOG['consumables']?.targets.find((row) => row.id === 'items')
  if (target === undefined) throw new Error('consumables items target missing')

  it('shows native items and one assigned item, and still offers Add beside native consumables', () => {
    const compiled = featureOf('filter')
    if (!compiled.ok) throw new Error(compiled.reason)
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [compiled.value],
    }
    render(
      <KeyedArrayCard
        device={HOST}
        handle={handleOf(composition)}
        availability={{ kind: 'present', mode: 'add' }}
        cap="consumables"
        target={target}
        defaults={NATIVE}
      />,
    )
    expect(screen.getByText('Salt')).toBeTruthy()
    expect(screen.getByText('Filter')).toBeTruthy()
    expect(screen.getByTestId('keyed-add-consumables')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
  })

  it('offers Add when the capability is assignable and nothing is stored', () => {
    render(
      <KeyedArrayCard
        device={HOST}
        handle={handleOf(null)}
        availability={{ kind: 'present', mode: 'add' }}
        cap="consumables"
        target={target}
        defaults={NONE}
      />,
    )
    expect(screen.getByTestId('keyed-add-consumables')).toBeTruthy()
  })

  it('opens the formula dialog for an unrecognised item and does not remove it', () => {
    const compiled = featureOf('filter')
    if (!compiled.ok) throw new Error(compiled.reason)
    const item = compiled.value.items?.['filter']
    if (item === undefined) throw new Error('no item')
    const status: CompositionFieldSource = { kind: 'expression', expr: '"ok"', bindings: {} }
    const mixed: CompositionFieldsFeature = {
      ...compiled.value,
      items: {
        ...compiled.value.items,
        filter: { ...item, fields: { ...item.fields, status } },
      },
    }
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
        this.open = true
      }
    }
    render(
      <KeyedArrayCard
        device={HOST}
        handle={handleOf({
          target: { kind: 'existing', device: TARGET },
          features: [mixed],
        })}
        availability={{ kind: 'absent' }}
        cap="consumables"
        target={target}
        defaults={NONE}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Formula$/ }))
    expect(screen.getByTestId('formula-dialog')).toBeTruthy()
  })

  it('add compiles a new item and saves it on the composition feature', () => {
    const compiled = featureOf('brine')
    if (!compiled.ok) throw new Error(compiled.reason)
    const saveMock = vi.fn(
      async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({ kind: 'saved' }),
    )
    const handle: CustomizationHandle = {
      target: TARGET,
      state: { kind: 'none' },
      saving: false,
      save: saveMock,
    }
    render(
      <KeyedArrayCard
        device={HOST}
        handle={handle}
        availability={{ kind: 'present', mode: 'add' }}
        cap="consumables"
        target={target}
        defaults={NONE}
      />,
    )
    fireEvent.click(screen.getByTestId('keyed-add-consumables'))
    fireEvent.click(screen.getByTestId('keyed-save-item'))
    expect(saveMock).toHaveBeenCalledOnce()
    const next = saveMock.mock.calls[0]?.[0]
    if (next === null || next === undefined) throw new Error('no composition saved')
    const feature = next.features.find(
      (row): row is CompositionFieldsFeature => row.kind === 'fields' && row.cap === 'consumables',
    )
    if (feature === undefined) throw new Error('consumables feature missing')
    expect(feature.items?.['brine']?.label).toBe('Filter')
  })

  it('refuses a duplicate key when adding an item', () => {
    const compiled = featureOf('filter')
    if (!compiled.ok) throw new Error(compiled.reason)
    dialogStub.key = 'filter'
    const composition: Composition = {
      target: { kind: 'existing', device: TARGET },
      features: [compiled.value],
    }
    const saveMock = vi.fn(
      async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({ kind: 'saved' }),
    )
    render(
      <KeyedArrayCard
        device={HOST}
        handle={{
          target: TARGET,
          state: presentState(composition),
          saving: false,
          save: saveMock,
        }}
        availability={{ kind: 'present', mode: 'add' }}
        cap="consumables"
        target={target}
        defaults={NONE}
      />,
    )
    fireEvent.click(screen.getByTestId('keyed-add-consumables'))
    fireEvent.click(screen.getByTestId('keyed-save-item'))
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/filter/i)
  })
})
