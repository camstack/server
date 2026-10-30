/**
 * Automations — a visual editor over the SAME runtime as Scripts.
 *
 * The list is a DataTable; the editor REPLACES it inline (same as Actions).
 * Selection lives in the URL (`?block=`, `?new=1`) and `useItemFormUrl` is its
 * ONLY writer: a second writer holding a stale copy of the query string drops
 * `?new` and the editor closes the moment it opens.
 * An automation IS a core block with an AUTOMATION_RECIPE literal.
 */

import type { CoreBlock, CoreBlockInput } from '@camstack/types'
import {
  DataTable,
  ErrorBox,
  TABLE_SCROLL_MAX_H,
  Skeleton,
  useConfirm,
  useItemFormUrl,
  useSystem,
  type DataColumn,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AutomationEditor } from './automation/AutomationEditor'
import {
  AutomationActions,
  AutomationEmptyState,
  AutomationEnabledSwitch,
  AutomationLastRunCell,
  AutomationSummary,
  AutomationTriggerCell,
} from './automation/AutomationList'
import {
  ejectRecipeFromCode,
  looksLikeAutomation,
  parseRecipeFromCode,
} from './automation/recipe-from-code'
import { EMPTY_RECIPE } from './automation/recipe-parts'
import { freshest, sortBlocksForDisplay, summariseBlocks } from './core-block-status'
import { useTranslation } from 'react-i18next'
import { pushToast } from '../../components/ui/toast-bus'

const BLOCKS_KEY = ['coreBlocks', 'list'] as const
const POLL_MS = 5_000

export interface AutomationsTabProps {
  /** Where an ejected block is handed over. Called with the block's id so the
   *  Scripts editor opens on the code the operator just took ownership of —
   *  landing on a list and having to find it again reads as a failed eject. */
  readonly onOpenScripts: (blockId?: string) => void
  /** Header "New automation" from Build page — open the editor once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AutomationsTab({
  onOpenScripts,
  createRequested = false,
  onCreateConsumed,
}: AutomationsTabProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const {
    state: formState,
    openNew,
    openEdit,
    close: closeForm,
  } = useItemFormUrl({ editKey: 'block', newKey: 'new' })
  const confirm = useConfirm()
  const [logsFor, setLogsFor] = useState<string | null>(null)

  const editingOpen = formState.mode !== 'closed'

  useEffect(() => {
    if (!createRequested) return
    openNew()
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed, openNew])

  const blocksQuery = useQuery({
    queryKey: BLOCKS_KEY,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<readonly CoreBlock[]> => {
      const result = await system.trpcClient.coreBlocks.list.query({})
      return result.blocks
    },
  })

  const refresh = (): void => {
    void blocksQuery.refetch()
  }

  /** Save closes the editor and says so; a failed save keeps it open (the error is inline). */
  const saved = (block: CoreBlock): void => {
    closeForm()
    refresh()
    pushToast({
      title: t('build.automationsTab.saved', 'Automation saved'),
      message: block.name,
      severity: 'info',
    })
  }

  const create = useMutation({
    mutationFn: (block: CoreBlockInput) => system.trpcClient.coreBlocks.create.mutate({ block }),
    onSuccess: (result) => saved(result.block),
  })
  const update = useMutation({
    mutationFn: (input: { blockId: string; block: CoreBlockInput }) =>
      system.trpcClient.coreBlocks.update.mutate(input),
    onSuccess: (result) => saved(result.block),
  })
  const remove = useMutation({
    mutationFn: (blockId: string) => system.trpcClient.coreBlocks.delete.mutate({ blockId }),
    onSuccess: refresh,
  })
  const setEnabled = useMutation({
    mutationFn: (input: { blockId: string; enabled: boolean }) =>
      system.trpcClient.coreBlocks.setEnabled.mutate(input),
    onSuccess: refresh,
  })
  const eject = useMutation({
    mutationFn: (block: CoreBlock) =>
      system.trpcClient.coreBlocks.update.mutate({
        blockId: block.id,
        block: {
          name: block.name,
          code: ejectRecipeFromCode(block.code),
          enabled: block.enabled,
          placement: block.placement,
          ...(block.integrationId === undefined ? {} : { integrationId: block.integrationId }),
        },
      }),
    onSuccess: (result) => {
      closeForm()
      refresh()
      onOpenScripts(result.block.id)
    },
  })

  const all = blocksQuery.data
  const automations = sortBlocksForDisplay((all ?? []).filter((b) => looksLikeAutomation(b.code)))
  const knowsThereAreNone = all !== undefined && automations.length === 0

  const editing =
    formState.mode === 'edit' ? (automations.find((b) => b.id === formState.id) ?? null) : null
  /** `?block=` names something not in the answered list: nothing to edit. */
  const editTargetMissing = formState.mode === 'edit' && all !== undefined && editing === null
  useEffect(() => {
    if (editTargetMissing) closeForm()
  }, [editTargetMissing, closeForm])
  const parsed = editing === null ? null : parseRecipeFromCode(editing.code)
  const saveError =
    create.error !== null
      ? errorMessage(create.error)
      : update.error !== null
        ? errorMessage(update.error)
        : eject.error !== null
          ? errorMessage(eject.error)
          : null

  const columns: DataColumn<CoreBlock>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('build.automationsTab.automation', 'Automation'),
        nowrap: false,
        render: (block) => {
          const recipe = parseRecipeFromCode(block.code)
          return (
            <AutomationSummary
              block={block}
              logsOpen={logsFor === block.id}
              unreadable={recipe.ok ? null : recipe.reason}
            />
          )
        },
        sortValue: (block) => block.name,
      },
      {
        key: 'trigger',
        header: t('build.automationsTab.trigger', 'Trigger'),
        render: (block) => {
          const recipe = parseRecipeFromCode(block.code)
          return <AutomationTriggerCell recipe={recipe.ok ? recipe.recipe : null} />
        },
        notSortableReason: t('build.automationsTab.triggerNotSortable', 'Read from the recipe'),
      },
      {
        key: 'lastRun',
        header: t('build.automationsTab.lastRun', 'Last run'),
        render: (block) => <AutomationLastRunCell blockId={block.id} />,
        notSortableReason: t('build.automationsTab.lastRunNotSortable', 'Read per automation'),
      },
      {
        key: 'enabled',
        header: t('build.automationsTab.enabled', 'Enabled'),
        render: (block) => (
          <AutomationEnabledSwitch
            block={block}
            disabled={setEnabled.isPending}
            onToggle={(enabled) => setEnabled.mutate({ blockId: block.id, enabled })}
          />
        ),
        sortValue: (block) => (block.enabled ? 1 : 0),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Row actions',
        render: (block) => {
          const recipe = parseRecipeFromCode(block.code)
          return (
            <AutomationActions
              unreadable={recipe.ok ? null : recipe.reason}
              onEdit={() => openEdit(block.id)}
              onToggleLogs={() => setLogsFor(logsFor === block.id ? null : block.id)}
              onDelete={() => {
                void confirm({
                  title: t(
                    'automation.automationList.deleteThisAutomation',
                    'Delete this automation?',
                  ),
                  message: t(
                    'automation.automationList.deleteMessage',
                    '{{name}} will be deleted. This cannot be undone.',
                    { name: block.name },
                  ),
                  confirmLabel: t('common.delete', 'Delete'),
                  variant: 'danger',
                }).then((accepted) => {
                  if (accepted) remove.mutate(block.id)
                })
              }}
            />
          )
        },
      },
    ],
    [confirm, logsFor, openEdit, remove, setEnabled, t],
  )

  if (editingOpen) {
    if (formState.mode === 'edit' && editing === null) return <Skeleton className="h-24 w-full" />
    return (
      <div className="space-y-3" data-testid="automation-editor-panel">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Workflow className="h-4 w-4 text-foreground-muted" />
          {editing !== null
            ? t('build.automationsTab.edit', 'Edit {{name}}', {
                name: editing.name,
              })
            : t('build.automationsTab.newAutomation', 'New automation')}
        </h3>
        <AutomationEditor
          key={editing?.id ?? 'new'}
          existing={editing}
          initialRecipe={parsed !== null && parsed.ok ? parsed.recipe : EMPTY_RECIPE}
          saving={create.isPending || update.isPending}
          saveError={saveError}
          ejecting={eject.isPending}
          onSave={(input) => {
            if (editing === null) create.mutate(input)
            else update.mutate({ blockId: editing.id, block: input })
          }}
          onEject={() => {
            if (editing !== null) eject.mutate(editing)
          }}
          onCancel={() => {
            create.reset()
            update.reset()
            eject.reset()
            closeForm()
          }}
        />
        {remove.error != null && <ErrorBox message={errorMessage(remove.error)} />}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        {all === undefined ? '' : summariseBlocks(automations)}
      </p>

      {blocksQuery.error != null && (
        <ErrorBox
          title={t(
            'build.automationsTab.couldNotReadTheAutomations',
            'Could not read the automations',
          )}
          message={errorMessage(blocksQuery.error)}
          onRetry={refresh}
        />
      )}

      {knowsThereAreNone ? (
        <AutomationEmptyState onCreate={openNew} />
      ) : (
        <DataTable
          columns={columns}
          rows={automations}
          rowKey={(b) => b.id}
          pageSize={25}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={
            all === undefined
              ? t('build.automationsTab.loadingAutomations', 'Loading automations…')
              : t('build.automationsTab.noAutomationsYet', 'No automations yet.')
          }
          onRowClick={(block) => openEdit(block.id)}
        />
      )}

      {remove.error != null && <ErrorBox message={errorMessage(remove.error)} />}
      {setEnabled.error != null && <ErrorBox message={errorMessage(setEnabled.error)} />}
    </div>
  )
}
