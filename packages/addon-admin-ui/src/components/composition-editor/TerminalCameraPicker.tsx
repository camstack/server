/**
 * The Terminal a camera block shows (planning#580). Every Terminal is listed;
 * one another block already shows is disabled and names that block. With no
 * Terminal at all the picker links to the Terminal page, where one is made.
 * A list that has not answered is never "none" (D315).
 */
import { Select, useCoreBlocksListCompositions, useInstancesOfCap } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { terminalCameraIndex, terminalChoices } from './camera-block-model'

const TERMINAL_CAP = 'terminal-session'
const TERMINAL_PAGE = '/system/terminal'

export interface TerminalCameraPickerProps {
  readonly value: string | null
  /** The block being edited: its own Terminal stays pickable. Null while creating. */
  readonly ownBlockId: string | null
  readonly onChange: (terminalId: string) => void
  readonly disabled?: boolean
}

export function TerminalCameraPicker({
  value,
  ownBlockId,
  onChange,
  disabled = false,
}: TerminalCameraPickerProps): ReactNode {
  const { t } = useTranslation()
  const terminals = useInstancesOfCap({ functionCap: TERMINAL_CAP })
  const compositions = useCoreBlocksListCompositions({}, {})
  const index = terminalCameraIndex(compositions.data, compositions.isError)
  const label = t('helper.terminal.pick')

  if (terminals.isError || index.kind === 'unknown') {
    return (
      <p className="text-[11px] text-foreground-muted" data-testid="terminal-camera-unknown">
        {t('helper.terminal.unknown')}
      </p>
    )
  }
  if (terminals.data === undefined || index.kind === 'pending') {
    return <p className="text-[11px] text-foreground-subtle">{t('common.loading')}</p>
  }
  if (terminals.data.length === 0) {
    return (
      <p className="text-[11px] text-foreground-muted" data-testid="terminal-camera-none">
        {t('helper.terminal.none')}{' '}
        <Link to={TERMINAL_PAGE} className="text-primary hover:underline">
          {t('helper.terminal.openPage')}
        </Link>
      </p>
    )
  }
  const choices = terminalChoices(terminals.data, index, ownBlockId)
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      {label}
      <Select
        aria-label={label}
        data-testid="terminal-camera-picker"
        disabled={disabled}
        value={value ?? ''}
        placeholder={t('helper.terminal.placeholder')}
        onChange={(event) => onChange(event.target.value)}
        options={choices.map((choice) => ({
          value: choice.id,
          label:
            choice.takenBy === null
              ? choice.name
              : t('helper.terminal.taken', {
                  name: choice.name,
                  block: choice.takenBy,
                }),
          disabled: choice.takenBy !== null,
        }))}
      />
    </label>
  )
}
