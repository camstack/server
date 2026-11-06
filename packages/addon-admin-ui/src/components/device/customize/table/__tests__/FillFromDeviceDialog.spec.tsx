import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { DeviceValueFieldStub } from '../../__tests__/device-value-field-stub'
import type { FieldRow } from '../field-rows'

const POND = {
  id: 7,
  name: 'Pond sensor',
  addonId: 'ha',
  stableId: 'pond',
  type: 'sensor',
  location: 'Garden',
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const HOST = { ...POND, id: 900, name: 'Fountain', stableId: 'fountain', type: DeviceType.Sensor }

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    DeviceValueField: DeviceValueFieldStub,
    useDeviceValueSource: () => ({
      devices: [{ id: 7, name: 'Pond sensor', location: 'Garden' }],
      listState: 'answered' as const,
      valuesState: 'ready' as const,
      groups: [],
    }),
    useDeviceManagerListAll: () => ({ status: 'success', data: [POND] }),
    useDeviceManagerGetWireableFields: () => ({
      status: 'success',
      data: {
        caps: [{ cap: 'temperature-sensor', fields: [{ path: 'celsius', kind: 'number' }] }],
      },
    }),
    useDeviceStateGetSnapshot: () => ({
      status: 'success',
      data: { 'temperature-sensor': { celsius: 21 } },
    }),
  }
})

const { FillFromDeviceDialog } = await import('../FillFromDeviceDialog')

const ROW: FieldRow = {
  key: 'temperature-sensor.celsius',
  cap: 'temperature-sensor',
  path: 'celsius',
  entry: null,
  advanced: false,
  item: null,
}

describe('FillFromDeviceDialog', () => {
  it('proposes the matching value, and saves it only when the operator applies', async () => {
    const save = vi.fn((_next: unknown) => Promise.resolve({ kind: 'saved' as const }))
    render(
      <FillFromDeviceDialog
        cap="temperature-sensor"
        title="Fill"
        rows={[ROW]}
        device={HOST}
        handle={{
          target: { addonId: 'composer', stableId: 'fountain' },
          state: { kind: 'none' },
          saving: false,
          save,
        }}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByTestId('fill-apply')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Pond sensor/ }))
    expect(screen.getByTestId('fill-row-temperature-sensor.celsius')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('fill-apply'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const composition = save.mock.calls[0]?.[0]
    expect(composition).toMatchObject({
      features: [
        {
          kind: 'fields',
          cap: 'temperature-sensor',
          fields: { celsius: { kind: 'from', source: { stableId: 'pond' } } },
        },
      ],
    })
  })
})
