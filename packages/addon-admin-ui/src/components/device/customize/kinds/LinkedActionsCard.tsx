/**
 * Linked actions (D356), as rows of the Customize table. Nothing is linked
 * on its own; the picker lists what exists and the operator ticks. Reads and
 * writes `actions.getLinks` / `actions.setLinks`.
 */
import type { ActionEntry, DeviceInfo } from '@camstack/types'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  useActionsGetLinks,
  useActionsList,
  useActionsRun,
  useActionsSetLinks,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Play, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface LinkedActionsState {
  readonly ready: boolean
  readonly rows: readonly ActionEntry[]
  readonly available: readonly ActionEntry[]
  readonly error: string | null
  readonly saving: boolean
  readonly running: boolean
  readonly deviceName: string
  readonly openPicker: () => void
  readonly unlink: (id: string) => void
  readonly run: (id: string) => void
  readonly dialog: ReactNode
}

export type LinkedActionTableLine =
  | { readonly kind: 'actionSection' }
  | { readonly kind: 'actionPending' }
  | { readonly kind: 'actionEmpty' }
  | { readonly kind: 'actionError'; readonly message: string }
  | { readonly kind: 'actionEntry'; readonly entry: ActionEntry }

export function linkedActionTableLines(
  state: Pick<LinkedActionsState, 'ready' | 'rows' | 'error'>,
): readonly LinkedActionTableLine[] {
  const error = state.error === null ? [] : [{ kind: 'actionError' as const, message: state.error }]
  if (!state.ready) return [{ kind: 'actionSection' }, { kind: 'actionPending' }, ...error]
  if (state.rows.length === 0) {
    return [{ kind: 'actionSection' }, { kind: 'actionEmpty' }, ...error]
  }
  return [
    { kind: 'actionSection' },
    ...state.rows.map((entry) => ({ kind: 'actionEntry' as const, entry })),
    ...error,
  ]
}

export function isLinkedActionLine(line: { readonly kind: string }): line is LinkedActionTableLine {
  return (
    line.kind === 'actionSection' ||
    line.kind === 'actionPending' ||
    line.kind === 'actionEmpty' ||
    line.kind === 'actionError' ||
    line.kind === 'actionEntry'
  )
}

export function useLinkedActions(device: DeviceInfo): LinkedActionsState {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const actions = useActionsList({})
  const links = useActionsGetLinks({ deviceId: device.id })
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState<readonly string[]>([])
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: [['actions']] })
  const save = useActionsSetLinks({ onSuccess: refresh })
  const run = useActionsRun({ onSuccess: refresh })
  const entries: readonly ActionEntry[] = actions.data ?? []
  const linkedIds: readonly string[] = links.data?.actionIds ?? []
  const rows = linkedIds.flatMap((id) => entries.filter((entry) => entry.id === id))
  const available = entries.filter((entry) => !linkedIds.includes(entry.id))
  const ready = links.data !== undefined && actions.data !== undefined
  const write = (actionIds: readonly string[]): void =>
    save.mutate({ deviceId: device.id, actionIds: [...actionIds] })
  const openPicker = (): void => {
    setDraft([])
    setPicking(true)
  }
  const toggle = (id: string): void =>
    setDraft(draft.includes(id) ? draft.filter((item) => item !== id) : [...draft, id])
  const error = save.error === null || save.error === undefined ? null : save.error.message
  return {
    ready,
    rows,
    available,
    error,
    saving: save.isPending,
    running: run.isPending,
    deviceName: device.name,
    openPicker,
    unlink: (id) => write(linkedIds.filter((linked) => linked !== id)),
    run: (id) => run.mutate({ actionId: id, deviceId: device.id }),
    dialog: (
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent placement="sheet-on-mobile">
          <DialogHeader>
            <DialogTitle>
              {t('customize.linkedActions.pickTitle', { name: device.name })}
            </DialogTitle>
            <DialogDescription>{t('customize.linkedActions.pickHint')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="space-y-1">
              {available.map((entry) => (
                <li key={entry.id}>
                  <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover">
                    <Checkbox
                      checked={draft.includes(entry.id)}
                      onChange={() => toggle(entry.id)}
                    />
                    <span className="flex-1">{entry.name}</span>
                    <SourceBadge entry={entry} />
                  </label>
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPicking(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              disabled={draft.length === 0 || save.isPending}
              onClick={() => {
                write([...linkedIds, ...draft])
                setPicking(false)
              }}
            >
              {t('customize.linkedActions.addN', { count: draft.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  }
}

function SourceBadge({ entry }: { readonly entry: ActionEntry }): ReactNode {
  const { t } = useTranslation()
  return entry.readOnly ? (
    <Badge variant="info">{entry.addonId}</Badge>
  ) : (
    <Badge variant="primary">{t('actions.source.internal', 'Internal')}</Badge>
  )
}

function Muted({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="text-xs text-foreground-subtle">{children}</span>
}

export function LinkedActionItem({ line }: { readonly line: LinkedActionTableLine }): ReactNode {
  const { t } = useTranslation()
  switch (line.kind) {
    case 'actionSection':
      return (
        <span
          className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted"
          title={t('customize.linkedActions.hint')}
        >
          {t('customize.table.section.actions')}
        </span>
      )
    case 'actionPending':
      return <Muted>{t('customize.linkedActions.loading')}</Muted>
    case 'actionEmpty':
      return <Muted>{t('customize.linkedActions.none')}</Muted>
    case 'actionError':
      return (
        <span role="alert" className="text-xs text-danger break-words">
          {line.message}
        </span>
      )
    case 'actionEntry':
      return <span className="text-xs text-foreground">{line.entry.name}</span>
  }
}

export function LinkedActionValue({ line }: { readonly line: LinkedActionTableLine }): ReactNode {
  const { t } = useTranslation()
  if (line.kind === 'actionEntry') {
    const steps = line.entry.steps
    if (steps === undefined) return <Muted>—</Muted>
    return (
      <span className="text-xs text-foreground">
        {t('customize.linkedActions.steps', { count: steps.length })}
      </span>
    )
  }
  if (line.kind === 'actionPending') return <Muted>{t('customize.linkedActions.loading')}</Muted>
  return null
}

export function LinkedActionSource({ line }: { readonly line: LinkedActionTableLine }): ReactNode {
  if (line.kind !== 'actionEntry') return null
  return <SourceBadge entry={line.entry} />
}

export function LinkedActionButtons({
  line,
  state,
}: {
  readonly line: LinkedActionTableLine
  readonly state: LinkedActionsState
}): ReactNode {
  const { t } = useTranslation()
  if (line.kind === 'actionSection' && state.ready && state.available.length > 0) {
    return (
      <Button variant="outline" size="sm" disabled={state.saving} onClick={state.openPicker}>
        {t('customize.linkedActions.add')}
      </Button>
    )
  }
  if (line.kind !== 'actionEntry') return null
  const { entry } = line
  return (
    <span className="flex items-center justify-end gap-1">
      <IconButton
        icon={Play}
        variant="ghost"
        size="sm"
        aria-label={t('customize.linkedActions.run', { name: entry.name })}
        disabled={state.running}
        onClick={() => state.run(entry.id)}
      />
      <IconButton
        icon={X}
        variant="ghost"
        size="sm"
        aria-label={t('customize.linkedActions.unlink', { name: entry.name })}
        disabled={state.saving}
        onClick={() => state.unlink(entry.id)}
      />
    </span>
  )
}
