/**
 * Linked actions (D356): the actions an operator chose to show on this camera.
 * Nothing is linked on its own; the picker lists what exists and the operator
 * ticks. Reads and writes `actions.getLinks` / `actions.setLinks`.
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
import { ListChecks, Play, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssignmentSection } from '../assignments/AssignmentSection'

export interface LinkedActionsCardProps {
  readonly device: DeviceInfo
}

const ROW = 'flex items-center gap-2 px-3 py-2 text-sm sm:px-4'
const NOTE = 'list-none px-3 py-2 text-xs text-foreground-subtle sm:px-4'

function SourceBadge({ entry }: { readonly entry: ActionEntry }): ReactNode {
  const { t } = useTranslation()
  return entry.readOnly ? (
    <Badge variant="info">{entry.addonId}</Badge>
  ) : (
    <Badge variant="primary">{t('actions.source.internal', 'Internal')}</Badge>
  )
}

export function LinkedActionsCard({ device }: LinkedActionsCardProps): ReactNode {
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
  const rows = linkedIds.flatMap((id) => entries.filter((e) => e.id === id))
  const available = entries.filter((e) => !linkedIds.includes(e.id))
  const ready = links.data !== undefined && actions.data !== undefined

  const write = (actionIds: readonly string[]): void =>
    save.mutate({ deviceId: device.id, actionIds: [...actionIds] })

  const open = (): void => {
    setDraft([])
    setPicking(true)
  }
  const toggle = (id: string): void =>
    setDraft(draft.includes(id) ? draft.filter((x) => x !== id) : [...draft, id])

  return (
    <>
      <AssignmentSection
        id="linked-actions"
        icon={ListChecks}
        title={t('customize.linkedActions.title', 'Linked actions')}
        addLabel={t('customize.linkedActions.add', 'Add')}
        onAdd={ready && available.length > 0 ? open : undefined}
        addDisabled={save.isPending}
      >
        {!ready && (
          <li className={NOTE}>
            {t('customize.linkedActions.loading', 'Checking linked actions.')}
          </li>
        )}
        {ready && rows.length === 0 && (
          <li className={NOTE}>{t('customize.linkedActions.none', 'None linked.')}</li>
        )}
        {rows.map((entry) => (
          <li key={entry.id} className={ROW}>
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <SourceBadge entry={entry} />
            <IconButton
              icon={Play}
              variant="ghost"
              size="sm"
              aria-label={t('customize.linkedActions.run', 'Run {{name}}', { name: entry.name })}
              disabled={run.isPending}
              onClick={() => run.mutate({ actionId: entry.id, deviceId: device.id })}
            />
            <IconButton
              icon={X}
              variant="ghost"
              size="sm"
              aria-label={t('customize.linkedActions.unlink', 'Unlink {{name}}', {
                name: entry.name,
              })}
              disabled={save.isPending}
              onClick={() => write(linkedIds.filter((id) => id !== entry.id))}
            />
          </li>
        ))}
        {save.error !== null && (
          <li role="alert" className="list-none px-3 py-2 text-xs text-danger sm:px-4">
            {save.error.message}
          </li>
        )}
        <li className={NOTE}>
          {t(
            'customize.linkedActions.hint',
            'Linked actions show as buttons on this camera. Nothing is linked unless you pick it.',
          )}
        </li>
      </AssignmentSection>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent placement="sheet-on-mobile">
          <DialogHeader>
            <DialogTitle>
              {t('customize.linkedActions.pickTitle', 'Link actions to {{name}}', {
                name: device.name,
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                'customize.linkedActions.pickHint',
                'Pick the actions to link. Nothing is chosen for you.',
              )}
            </DialogDescription>
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
              {t('customize.linkedActions.addN', 'Add {{count}}', { count: draft.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
