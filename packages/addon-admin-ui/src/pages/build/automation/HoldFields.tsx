/**
 * "for N s · held | stable ± tolerance" — the ONE hold control of a `when` row
 * (#498), shared by the device value that becomes, the device that is, and the
 * expression.
 *
 *  - **held** — the condition stays true for the whole window;
 *  - **stable** — the value does not move by more than the tolerance for the
 *    whole window ("unchanged for 30 s"). The tolerance is absolute, in the
 *    field's base unit.
 *
 * Seconds on screen, milliseconds in the recipe. An empty mode means no hold
 * at all, which is not the same as a zero-second one.
 */

import type { HoldMode, HoldSpec } from '@dominevo/types'
import { Input, Select, DurationInput } from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import { PickerLabel } from './FieldPicker'

const NO_HOLD = 'none'

export interface HoldFieldsProps {
  readonly hold: HoldSpec | undefined
  /** An expression has no single value to keep still, so it offers only `held`. */
  readonly modes: readonly HoldMode[]
  readonly onChange: (next: HoldSpec | undefined) => void
}

export function HoldFields({ hold, modes, onChange }: HoldFieldsProps) {
  const { t } = useTranslation()
  const labels: Readonly<Record<HoldMode, string>> = {
    held: t('automation.hold.held', 'held'),
    stable: t('automation.hold.stable', 'stable'),
  }
  const setMode = (raw: string): void => {
    if (raw === NO_HOLD) {
      onChange(undefined)
      return
    }
    const mode = modes.find((m) => m === raw)
    if (mode === undefined) return
    const ms = hold?.ms ?? 30_000
    onChange(
      mode === 'stable' && hold?.tolerance !== undefined
        ? { ms, mode, tolerance: hold.tolerance }
        : { ms, mode },
    )
  }
  return (
    <>
      <label className="w-32">
        <PickerLabel>{t('automation.hold.label', 'For')}</PickerLabel>
        <Select
          value={hold?.mode ?? NO_HOLD}
          onChange={(e) => setMode(e.target.value)}
          options={[
            { value: NO_HOLD, label: t('automation.hold.none', 'no hold') },
            ...modes.map((m) => ({ value: m, label: labels[m] })),
          ]}
        />
      </label>
      {hold !== undefined && (
        <div>
          <PickerLabel>{t('automation.hold.seconds', 'Seconds')}</PickerLabel>
          <DurationInput
            aria-label={t('automation.hold.seconds', 'Seconds')}
            value={hold.ms / 1000}
            fractional
            min={0}
            testIdPrefix="hold-duration"
            onChange={(seconds) =>
              onChange(seconds > 0 ? { ...hold, ms: Math.round(seconds * 1000) } : undefined)
            }
          />
        </div>
      )}
      {hold?.mode === 'stable' && (
        <label className="w-28">
          <PickerLabel>{t('automation.hold.tolerance', '± tolerance')}</PickerLabel>
          <Input
            type="number"
            min={0}
            step="any"
            value={hold.tolerance === undefined ? '' : String(hold.tolerance)}
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value.trim()
              const tolerance = raw === '' ? Number.NaN : Number(raw)
              const { tolerance: _dropped, ...rest } = hold
              onChange(Number.isNaN(tolerance) || tolerance < 0 ? rest : { ...rest, tolerance })
            }}
          />
        </label>
      )}
    </>
  )
}
