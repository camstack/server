/**
 * The "Source device" runner: picking a device reads its fields, then saves the four filled
 * features exactly once, from the composition as it stands when the save is made.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type Composition,
  CompositionViewSchema,
  type CustomizeCatalog,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CustomizationHandle } from '../../use-customization'

const HOST = { addonId: 'provider-x', stableId: 'dryer' }

interface WireableAnswer {
  status: 'pending' | 'success'
  data: unknown
}
const wireable: { current: WireableAnswer } = { current: { status: 'pending', data: undefined } }

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    DeviceValuePicker: (props: {
      readonly testId?: string
      readonly onChange: (picked: { deviceId: number }) => void
    }) => (
      <button
        type="button"
        data-testid={props.testId}
        onClick={() => props.onChange({ deviceId: 560 })}
      >
        pick
      </button>
    ),
    useDeviceManagerListAll: () => ({
      status: 'success',
      error: null,
      data: [
        {
          id: 560,
          name: 'Meter plug',
          addonId: 'provider-x',
          stableId: 'plug-meter',
          type: 'plug',
          location: null,
          isCamera: false,
          parentDeviceId: null,
        },
      ],
    }),
    useIntegrationsList: () => ({ data: [] }),
    useDeviceManagerGetWireableFields: () => ({
      status: wireable.current.status,
      data: wireable.current.data,
      error: null,
    }),
    useDeviceStateGetSnapshot: () => ({ status: 'success', data: {}, error: null }),
  }
})

const { SourceGroupCell } = await import('../SourceGroupCell')

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG
const group = (() => {
  const found = catalog['power-meter']?.sourceGroups?.[0]
  if (found === undefined) throw new Error('power-meter declares no source group')
  return found
})()

const REPORTED = {
  caps: [
    {
      cap: 'power-meter',
      fields: ['power', 'energy', 'voltage', 'current'].map((path) => ({ path, kind: 'number' })),
    },
  ],
}

type Save = CustomizationHandle['save']

function viewOf(composition: Composition) {
  return CompositionViewSchema.parse({
    block: {
      id: 'blk-dryer',
      name: 'customize:dryer',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'admin',
      status: 'running',
      lastChangedAt: 1,
      source: { kind: 'composition', composition },
    },
    state: { kind: 'answered', state: null },
  })
}

function noneHandle(save: Save): CustomizationHandle {
  return { target: HOST, state: { kind: 'none' }, saving: false, save }
}

function cell(handle: CustomizationHandle): ReactNode {
  return <SourceGroupCell device={{ id: 505 }} handle={handle} cap="power-meter" group={group} />
}

describe('SourceGroupCell fill', () => {
  it('saves once, with the four readings, after a pick', async () => {
    wireable.current = { status: 'success', data: REPORTED }
    const save = vi.fn<Save>(async () => ({ kind: 'saved' }))
    render(cell(noneHandle(save)))
    fireEvent.click(screen.getByTestId('source-group-picker-power-meter'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const saved = JSON.stringify(save.mock.calls[0]?.[0])
    expect(saved).toContain('plug-meter')
    for (const field of ['power', 'energy', 'voltage', 'current']) {
      expect(saved).toContain(`"fieldPath":"${field}"`)
    }
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps an edit a per-field row saved while the device data was still loading', async () => {
    wireable.current = { status: 'pending', data: undefined }
    const save = vi.fn<Save>(async () => ({ kind: 'saved' }))
    const { rerender } = render(cell(noneHandle(save)))
    fireEvent.click(screen.getByTestId('source-group-picker-power-meter'))
    expect(save).not.toHaveBeenCalled()
    const edited: Composition = {
      target: { kind: 'existing', device: HOST },
      features: [
        {
          kind: 'fields',
          cap: 'power-meter',
          fields: { lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} } },
        },
      ],
    }
    wireable.current = { status: 'success', data: REPORTED }
    rerender(
      cell({
        ...noneHandle(save),
        state: { kind: 'present', composition: edited, view: viewOf(edited) },
      }),
    )
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(save.mock.calls[0]?.[0])).toContain('lastFetchedAt')
  })
})
