/**
 * The "Suggested · <room>" group at the top of a Customize picker (D749): the
 * room's devices that are valid for the card, each with a one-click action
 * that IS the picker's own pick (add it, or use it as the field's device).
 * Drawn from the tab's list-row chrome; it owns no data and writes nothing.
 */
import { Button, LIST_ROW, TEXT_SECTION_LABEL, useDeviceLabelById } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface SuggestedDevice {
  readonly id: number
  readonly name: string
  /** The container it lives in — a child is named after it. */
  readonly container: string | null
  readonly detail: string | null
}

export interface SuggestedDevicesProps {
  readonly location: string
  readonly devices: readonly SuggestedDevice[]
  /** `add` for a card that adds the device; `use` for the field picker's device step. */
  readonly action: 'add' | 'use'
  readonly onPick: (id: number) => void
  /** Present = "Add all" when more than one can be added at once. */
  readonly onPickAll?: () => void
}

interface SuggestedRowProps {
  readonly device: SuggestedDevice
  readonly action: 'add' | 'use'
  readonly onPick: (id: number) => void
}

function SuggestedRow({ device, action, onPick }: SuggestedRowProps): ReactNode {
  const { t } = useTranslation()
  const label = useDeviceLabelById(device.id, 'compact', device.name)
  const inContainer =
    device.container === null || label.includes(device.container)
      ? null
      : t('customize.suggest.in', { container: device.container })
  const second = [inContainer, device.detail]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ')
  return (
    <li className={`${LIST_ROW} flex items-center gap-3`}>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-foreground break-words">{label}</div>
        {second !== '' && (
          <div className="text-[11px] text-foreground-subtle break-words">{second}</div>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={t(
          action === 'add' ? 'customize.suggest.addNamed' : 'customize.suggest.useNamed',
          { name: label },
        )}
        onClick={() => onPick(device.id)}
      >
        {t(action === 'add' ? 'customize.suggest.add' : 'customize.suggest.use')}
      </Button>
    </li>
  )
}

export function SuggestedDevices({
  location,
  devices,
  action,
  onPick,
  onPickAll,
}: SuggestedDevicesProps): ReactNode {
  const { t } = useTranslation()
  if (devices.length === 0) return null
  const heading = t('customize.suggest.heading', { location })
  return (
    <section aria-label={heading} className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>{heading}</h3>
        {onPickAll !== undefined && devices.length > 1 && (
          <Button variant="ghost" size="sm" onClick={onPickAll}>
            {t('customize.suggest.addAll', { count: devices.length })}
          </Button>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {devices.map((device) => (
          <SuggestedRow key={device.id} device={device} action={action} onPick={onPick} />
        ))}
      </ul>
    </section>
  )
}
