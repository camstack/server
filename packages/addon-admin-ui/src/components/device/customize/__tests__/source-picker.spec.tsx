import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import {
  formatLiveValue,
  type PickerDevice,
  pickerFieldRows,
  searchPickerDevices,
  type WireableCatalog,
} from '../source-picker-model'

const BATTERY_DEV: PickerDevice = {
  id: 4131,
  name: 'Fresh Element 3 Battery',
  addonId: 'provider-homeassistant',
  stableId: 'sensor.freshelement_3_battery',
  location: 'Kitchen',
  type: 'sensor',
}
const DAYS_DEV: PickerDevice = {
  id: 4132,
  name: 'Fresh Element 3 Desiccant left days',
  addonId: 'provider-homeassistant',
  stableId: 'sensor.freshelement_3_desiccant_left_days',
  location: 'Kitchen',
  type: 'sensor',
}
const CAM: PickerDevice = {
  id: 101,
  name: 'Camera front door',
  addonId: 'provider-hikvision',
  stableId: 'mac-40acbf7be9f7',
  location: 'Front door',
  type: 'camera',
}

describe('searchPickerDevices', () => {
  it('matches name, stableId and location; excludes; empty query lists nothing', () => {
    const all = [BATTERY_DEV, DAYS_DEV, CAM]
    expect(searchPickerDevices(all, 'freshelement', []).map((d) => d.id)).toEqual([4131, 4132])
    expect(searchPickerDevices(all, 'front door', [101])).toEqual([])
    expect(searchPickerDevices(all, '  ', [])).toEqual([])
  })
})

describe('formatLiveValue (review L3, D315)', () => {
  it('an unanswered snapshot is "…", an answered empty value is "—"', () => {
    expect(formatLiveValue(undefined, false)).toBe('…')
    expect(formatLiveValue(undefined, true)).toBe('—')
    expect(formatLiveValue(87, true)).toBe('87')
  })
})

describe('pickerFieldRows', () => {
  const catalog: WireableCatalog = {
    caps: [
      {
        cap: 'numeric-sensor',
        fields: [
          { path: 'value', kind: 'number' },
          { path: 'unit', kind: 'string' },
        ],
      },
      { cap: 'consumables', fields: [{ path: 'level', kind: 'number', item: true }] },
    ],
  }
  it('offers compatible fields with their live value; item leaves are never offered', () => {
    const rows = pickerFieldRows(
      BATTERY_DEV,
      catalog,
      { 'numeric-sensor': { value: 87, unit: '%' } },
      'number',
    )
    expect(rows.map((r) => [r.cap, r.path, r.value, r.source?.kind ?? null])).toEqual([
      ['numeric-sensor', 'value', 87, 'from'],
      ['numeric-sensor', 'unit', '%', 'expression'],
    ])
  })
  it('an incompatible field has no source — it is shown as hidden, not offered', () => {
    const rows = pickerFieldRows(BATTERY_DEV, catalog, null, 'boolean')
    expect(rows.every((r) => r.source === null)).toBe(true)
    expect(rows[0]?.value).toBeUndefined()
  })
})

type ListAllState =
  | { readonly status: 'success'; readonly data: readonly unknown[] }
  | {
      readonly status: 'error'
      readonly data: readonly unknown[]
      readonly error: { readonly message: string }
    }
type SnapshotState =
  | {
      readonly status: 'success'
      readonly data: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
  | { readonly status: 'error'; readonly error: { readonly message: string } }
const SNAPSHOT_OK: SnapshotState = {
  status: 'success',
  data: { 'numeric-sensor': { value: 87, unit: '%' }, binary: { on: true } },
}
const snapshotRead = vi.hoisted((): { current: SnapshotState | null } => ({ current: null }))
snapshotRead.current = SNAPSHOT_OK
const listAll = vi.hoisted((): { current: ListAllState } => ({
  current: { status: 'success', data: [] },
}))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => listAll.current,
    useDeviceManagerGetWireableFields: () => ({
      status: 'success',
      data: {
        caps: [
          {
            cap: 'numeric-sensor',
            fields: [
              { path: 'value', kind: 'number' },
              { path: 'unit', kind: 'string' },
            ],
          },
          { cap: 'binary', fields: [{ path: 'on', kind: 'boolean' }] },
        ],
      },
    }),
    useDeviceStateGetSnapshot: () => snapshotRead.current,
  }
})
const { SourcePicker } = await import('../SourcePicker')

beforeEach(() => {
  snapshotRead.current = SNAPSHOT_OK
  listAll.current = {
    status: 'success',
    data: [
      {
        ...BATTERY_DEV,
        disabled: false,
        parentDeviceId: null,
        online: true,
        features: [],
        isCamera: false,
        config: {},
        role: null,
      },
    ],
  }
})

describe('SourcePicker (D676 ruling 9)', () => {
  it('device, then its compatible fields with live values; the pick carries the ref', () => {
    const onPick = vi.fn()
    render(
      <SourcePicker
        title="Take from…"
        targetKind="number"
        onPick={onPick}
        onCancel={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search a device'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: /Fresh Element 3 Battery/ }))
    expect(screen.getByText('87')).toBeTruthy()
    expect(screen.queryByRole('option', { name: /binary\.on/ })).toBeNull()
    expect(screen.getByText('1 field is not a number and cannot be used here')).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /numeric-sensor\.value/ }))
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' },
        cap: 'numeric-sensor',
        path: 'value',
        kind: 'number',
        value: 87,
        source: {
          kind: 'from',
          source: { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' },
          cap: 'numeric-sensor',
          fieldPath: 'value',
        },
      }),
    )
  })
  it('a failed snapshot leaves every value unknown ("…"), never "—" (block-4 LOW-2, D315)', () => {
    snapshotRead.current = { status: 'error', error: { message: 'state timeout' } }
    render(
      <SourcePicker
        title="Take from…"
        targetKind="number"
        onPick={() => undefined}
        onCancel={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search a device'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: /Fresh Element 3 Battery/ }))
    expect(screen.getByText(/state timeout/)).toBeTruthy()
    const row = screen.getByRole('option', { name: /numeric-sensor\.value/ })
    expect(row.textContent).toContain('…')
    expect(row.textContent).not.toContain('—')
  })
  it('a device list that failed to load says so — never "no devices"', () => {
    listAll.current = { status: 'error', data: [], error: { message: 'timeout' } }
    render(
      <SourcePicker
        title="Take from…"
        targetKind="number"
        onPick={() => undefined}
        onCancel={() => undefined}
      />,
    )
    expect(screen.getByText(/timeout/)).toBeTruthy()
  })
})
