/**
 * Per-source camera-sensor mode control (motion span). Shared by span dialog
 * and {@link SourceSelector} event kind.
 */
import type { CameraSensorMode } from '@camstack/types'
import { Select } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

function modeOf(value: string, allowed: readonly CameraSensorMode[]): CameraSensorMode | null {
  return allowed.find((mode) => mode === value) ?? null
}

export interface ModeLineProps {
  readonly mode: CameraSensorMode
  readonly modes: readonly CameraSensorMode[]
  readonly name: string
  readonly onChange: (mode: CameraSensorMode) => void
}

export function ModeLine({ mode, modes, name, onChange }: ModeLineProps): ReactNode {
  const { t } = useTranslation()
  if (modes.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={t('customize.motion.modeFor', { name })}
        value={mode}
        options={modes.map((item) => ({
          value: item,
          label: t(`customize.motion.mode.${item}`),
        }))}
        onChange={(event) => {
          const next = modeOf(event.target.value, modes)
          if (next !== null) onChange(next)
        }}
      />
      <p className="text-[11px] text-foreground-muted">{t(`customize.motion.modeLine.${mode}`)}</p>
    </div>
  )
}
