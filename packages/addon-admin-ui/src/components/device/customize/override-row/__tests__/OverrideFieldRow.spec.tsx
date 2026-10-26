/**
 * A numeric override row offers from-device, formula, and convert-unit.
 * No free text input on the row itself.
 */
import { DeviceType, type Composition, type DeviceInfo } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { presentState } from '../../kinds/__tests__/customization-fixture'
import type { CustomizationHandle, CustomizationSaveOutcome } from '../../use-customization'
import { OverrideFieldRow } from '../OverrideFieldRow'

vi.mock('../../../../composition-editor/LivePreview', () => ({ LivePreview: () => null }))

vi.mock('../../SourcePicker', () => ({
  SourcePicker: () => null,
}))

vi.mock('@camstack/ui-library', () => {
  return {
    CollapsibleCard: ({
      header,
      children,
      expanded,
      onExpandedChange,
    }: {
      readonly header: ReactNode
      readonly children?: ReactNode
      readonly expanded: boolean
      readonly onExpandedChange: (next: boolean) => void
    }) => (
      <section>
        <div onClick={() => onExpandedChange(!expanded)}>{header}</div>
        {expanded ? children : null}
      </section>
    ),
    Button: ({
      children,
      onClick,
      disabled,
      ...rest
    }: {
      readonly children?: ReactNode
      readonly onClick?: () => void
      readonly disabled?: boolean
      readonly 'data-testid'?: string
    }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...rest}>
        {children}
      </button>
    ),
    Badge: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
    Switch: () => null,
    Select: ({
      options,
      value,
      onChange,
      'aria-label': ariaLabel,
    }: {
      readonly options: readonly { readonly value: string; readonly label: string }[]
      readonly value?: string
      readonly onChange?: (event: { readonly target: { readonly value: string } }) => void
      readonly 'aria-label'?: string
    }) => (
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange?.({ target: { value: event.target.value } })}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Dropdown: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DropdownTrigger: ({
      children,
      onClick,
      ...rest
    }: {
      readonly children?: ReactNode
      readonly onClick?: () => void
      readonly 'data-testid'?: string
    }) => (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    ),
    DropdownContent: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DropdownItem: ({
      children,
      onClick,
    }: {
      readonly children?: ReactNode
      readonly onClick?: () => void
    }) => (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    ),
    Dialog: ({ open, children }: { readonly open?: boolean; readonly children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogBody: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    useConfirm: () => async () => true,
    useDeviceManagerGetBindings: () => ({
      data: {
        entries: [
          { capName: 'temperature-sensor', nativeAddonId: 'provider-homeassistant' },
          { capName: 'humidity-sensor', nativeAddonId: 'provider-homeassistant' },
        ],
      },
    }),
  }
})

vi.mock('../../assignments/use-live-value', () => ({
  useLiveValue: () => ({ kind: 'value', value: 21.4 }),
}))

vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({ kind: 'known', value: [] }),
}))

const DEVICE = {
  id: 801,
  stableId: 'dev-801',
  addonId: 'provider-homeassistant',
  type: DeviceType.Sensor,
  name: 'Porch thermostat',
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

const SELF = { addonId: DEVICE.addonId, stableId: DEVICE.stableId }

function handleOf(composition: Composition | null): CustomizationHandle {
  return {
    target: SELF,
    state: composition === null ? { kind: 'none' } : presentState(composition),
    saving: false,
    save: async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({
      kind: 'saved',
    }),
  }
}

function fieldRow(handle: CustomizationHandle, unit: string): ReactNode {
  return (
    <OverrideFieldRow
      deviceId={DEVICE.id}
      self={SELF}
      selfName={DEVICE.name}
      cap={unit === '%' ? 'humidity-sensor' : 'temperature-sensor'}
      fieldPath={unit === '%' ? 'percent' : 'celsius'}
      label={unit === '%' ? 'Humidity' : 'Temperature'}
      unit={unit}
      handle={handle}
      names={new Map()}
    />
  )
}

describe('numeric override row', () => {
  it('offers from a device, formula, and convert unit, and the row has no text input', () => {
    const { container } = render(fieldRow(handleOf(null), '°C'))
    expect(container.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByTestId('override-add-temperature-sensor-celsius'))
    const row = screen.getByTestId('override-row-temperature-sensor-celsius')
    expect(within(row).getByRole('menuitem', { name: 'From a device' })).toBeTruthy()
    expect(within(row).getByRole('menuitem', { name: 'Formula' })).toBeTruthy()
    expect(within(row).getByRole('menuitem', { name: 'Convert unit' })).toBeTruthy()
    expect(screen.getAllByText('Current value').length).toBeGreaterThan(0)
    expect(within(row).getByText('21.4')).toBeTruthy()
    expect(screen.getAllByText('No override').length).toBeGreaterThan(0)
  })

  it('round-trips convert unit onto the composition, including the unit field', () => {
    const save = vi.fn(
      async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({
        kind: 'saved',
      }),
    )
    const handle = { ...handleOf(null), save }
    render(fieldRow(handle, '°C'))
    const temperature = screen.getByTestId('override-row-temperature-sensor-celsius')
    fireEvent.click(within(temperature).getByTestId('override-add-temperature-sensor-celsius'))
    fireEvent.click(within(temperature).getByRole('menuitem', { name: 'Convert unit' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Target unit' }), {
      target: { value: '°F' },
    })
    fireEvent.click(screen.getByTestId('convert-unit-publish'))
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0]?.[0]
    expect(saved).toMatchObject({
      features: [
        {
          kind: 'fields',
          cap: 'temperature-sensor',
          fields: {
            celsius: {
              kind: 'expression',
              expr: 'convert(v, "°C", "°F")',
              bindings: {
                v: {
                  kind: 'from',
                  source: SELF,
                  cap: 'temperature-sensor',
                  fieldPath: 'celsius',
                },
              },
            },
            unit: { kind: 'expression', expr: '"°F"', bindings: {} },
          },
        },
      ],
    })
  })

  it('round-trips a formula whose source is this device native value', () => {
    const save = vi.fn(
      async (_next: Composition | null): Promise<CustomizationSaveOutcome> => ({
        kind: 'saved',
      }),
    )
    const handle = { ...handleOf(null), save }
    render(fieldRow(handle, '°C'))
    const temperature = screen.getByTestId('override-row-temperature-sensor-celsius')
    fireEvent.click(within(temperature).getByTestId('override-add-temperature-sensor-celsius'))
    fireEvent.click(within(temperature).getByRole('menuitem', { name: 'Formula' }))
    fireEvent.click(screen.getByTestId('formula-self-native'))
    const expr = screen.getByRole('textbox')
    fireEvent.change(expr, { target: { value: 'v * 2' } })
    fireEvent.click(screen.getByTestId('formula-dialog-save'))
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0]?.[0]
    expect(saved).toMatchObject({
      features: [
        {
          kind: 'fields',
          cap: 'temperature-sensor',
          fields: {
            celsius: {
              kind: 'expression',
              expr: 'v * 2',
              bindings: {
                v: {
                  kind: 'from',
                  source: SELF,
                  cap: 'temperature-sensor',
                  fieldPath: 'celsius',
                },
              },
            },
          },
        },
      ],
    })
  })

  it('hides convert unit when the field unit has no other unit', () => {
    render(fieldRow(handleOf(null), '%'))
    const humidity = screen.getByTestId('override-row-humidity-sensor-percent')
    fireEvent.click(within(humidity).getByTestId('override-add-humidity-sensor-percent'))
    expect(within(humidity).getByRole('menuitem', { name: 'From a device' })).toBeTruthy()
    expect(within(humidity).getByRole('menuitem', { name: 'Formula' })).toBeTruthy()
    expect(within(humidity).queryByRole('menuitem', { name: 'Convert unit' })).toBeNull()
  })
})
