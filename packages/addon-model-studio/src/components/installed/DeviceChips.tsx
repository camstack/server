/**
 * The devices of a file's format, as chips (Installed rows). A chip says what
 * its device does with THIS file: loaded in its pool, configured for it,
 * neither, or the device is off. Interactive only where a click does what it
 * says: a configured chip opens the device's step settings, an enabled idle
 * chip pins the model as that device's base (with a confirm). A cluster-scoped
 * model is changed in the Cluster models section — its chips are read-only.
 */
import { CHIP_BASE, cn } from '@camstack/ui-library'
import type { InstalledDeviceChip } from '../../ui/installed-inventory.js'
import { useT } from '../../i18n/index.js'

export interface DeviceChipsProps {
  readonly chips: readonly InstalledDeviceChip[]
  /** Absent ⇒ every chip is read-only. */
  readonly onChip?: (chip: InstalledDeviceChip) => void
  readonly disabled?: boolean
}

type ChipState =
  | 'off'
  | 'loadedConfigured'
  | 'loaded'
  | 'configuredNotLoaded'
  | 'unknown'
  | 'notUsed'

/** The stable English state names exposed as `data-state` (a test / automation hook, not UI text). */
const STATE_ATTR: Readonly<Record<ChipState, string>> = {
  off: 'off',
  loadedConfigured: 'loaded, configured',
  loaded: 'loaded',
  configuredNotLoaded: 'configured, not loaded',
  unknown: 'load state unknown',
  notUsed: 'not used',
}

function chipState(chip: InstalledDeviceChip): ChipState {
  if (!chip.enabled) return 'off'
  if (chip.loaded === true) return chip.configured ? 'loadedConfigured' : 'loaded'
  if (chip.configured) return 'configuredNotLoaded'
  if (chip.loaded === null) return 'unknown'
  return 'notUsed'
}

function chipTone(chip: InstalledDeviceChip): string {
  if (!chip.enabled) return 'border-border bg-foreground-subtle/35'
  if (chip.loaded === true) return 'border-success/40 bg-success/10 text-success'
  if (chip.configured) return 'border-primary/50 bg-primary/10 text-primary'
  return 'border-border bg-surface text-foreground-subtle'
}

function Dot({ chip }: { readonly chip: InstalledDeviceChip }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 rounded-full',
        chip.loaded === true
          ? 'bg-success'
          : chip.configured
            ? 'border border-primary'
            : 'border border-foreground-subtle/60',
      )}
    />
  )
}

export function DeviceChips({ chips, onChip, disabled = false }: DeviceChipsProps) {
  const { t } = useT()
  if (chips.length === 0) {
    return <span className="text-[10px] text-foreground-subtle">{t('deviceChips.none')}</span>
  }
  return (
    <span className="flex flex-wrap gap-1" data-testid="installed-device-chips">
      {chips.map((chip) => {
        const stateCode = chipState(chip)
        const state = t(`deviceChips.state.${stateCode}`)
        const chipLabel = t('deviceChips.chipLabel', {
          label: chip.label,
          deviceKey: chip.deviceKey,
          state,
        })
        const plainTitle = t('deviceChips.title', { deviceKey: chip.deviceKey, state })
        if (!chip.enabled) {
          return (
            <span
              key={chip.deviceKey}
              className={cn(CHIP_BASE, chipTone(chip), 'min-w-[1.75rem] justify-center px-1.5')}
              data-device-key={chip.deviceKey}
              data-state={STATE_ATTR[stateCode]}
              aria-label={chipLabel}
              title={plainTitle}
            />
          )
        }
        const interactive = onChip !== undefined && !disabled
        const className = cn(CHIP_BASE, chipTone(chip), interactive && 'hover:border-primary/60')
        const content = (
          <>
            <Dot chip={chip} />
            {chip.label}
          </>
        )
        return interactive ? (
          <button
            key={chip.deviceKey}
            type="button"
            className={className}
            onClick={() => onChip(chip)}
            data-device-key={chip.deviceKey}
            data-state={STATE_ATTR[stateCode]}
            aria-label={chipLabel}
            title={
              chip.configured
                ? t('deviceChips.titleOpenSettings', { deviceKey: chip.deviceKey, state })
                : t('deviceChips.titlePin', { deviceKey: chip.deviceKey, state })
            }
          >
            {content}
          </button>
        ) : (
          <span
            key={chip.deviceKey}
            className={className}
            data-device-key={chip.deviceKey}
            data-state={STATE_ATTR[stateCode]}
            aria-label={chipLabel}
            title={plainTitle}
          >
            {content}
          </span>
        )
      })}
    </span>
  )
}
