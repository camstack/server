/**
 * Automations — a visual editor over the SAME runtime as Scripts.
 *
 * List is DataTable + ItemFormDialog (same contract as Scripts / NC Rules).
 * An automation IS a core block with an AUTOMATION_RECIPE literal.
 */

import type { CoreBlock, CoreBlockInput } from '@camstack/types'
import {
  DataTable,
  ErrorBox,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useItemFormUrl,
  useSystem,
  type DataColumn,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Workflow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AutomationEditor } from './automation/AutomationEditor'
import {
  AutomationActions,
  AutomationEmptyState,
  AutomationSummary,
} from './automation/AutomationList'
import {
  ejectRecipeFromCode,
  looksLikeAutomation,
  parseRecipeFromCode,
} from './automation/recipe-from-code'
import { EMPTY_RECIPE } from './automation/recipe-parts'
import { freshest, sortBlocksForDisplay, summariseBlocks } from './core-block-status'
import { useTranslation } from 'react-i18next'

const BLOCKS_KEY = ['coreBlocks', 'list'] as const
const POLL_MS = 5_000

export interface AutomationsTabProps {
  /** Where an ejected block is handed over. Called with the block's id so the
   *  Scripts editor opens on the code the operator just took ownership of —
   *  landing on a list and having to find it again reads as a failed eject. */
  readonly onOpenScripts: (blockId?: string) => void
  /**
   * A block to open on arrival (`?block=`). Applied at most once per id so a
   * stale param cannot keep re-opening the editor.
   */
  readonly initialBlockId?: string
  /** Keep `?block=` in sync with the open editor (null when closed / new). */
  readonly onBlockIdChange?: (blockId: string | null) => void
  /** Header "New automation" from Build page — open the editor once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AutomationsTab({
  onOpenScripts,
  initialBlockId,
  onBlockIdChange,
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
  const [savedBlock, setSavedBlock] = useState<CoreBlock | null>(null)
  const confirm = useConfirm()
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const openedFor = useRef<string | null>(null)

  const editingOpen = formState.mode !== 'closed'

  useEffect(() => {
    if (!createRequested) return
    setSavedBlock(null)
    openNew()
    onBlockIdChange?.(null)
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed, onBlockIdChange, openNew])

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

  const listed = blocksQuery.data
  useEffect(() => {
    if (initialBlockId === undefined || openedFor.current === initialBlockId) return
    const target = listed?.find((b) => b.id === initialBlockId && looksLikeAutomation(b.code))
    if (target === undefined) return
    openedFor.current = initialBlockId
    openEdit(initialBlockId)
    onBlockIdChange?.(initialBlockId)
  }, [initialBlockId, listed, openEdit, onBlockIdChange])

  const create = useMutation({
    mutationFn: (block: CoreBlockInput) => system.trpcClient.coreBlocks.create.mutate({ block }),
    onSuccess: (result) => {
      setSavedBlock(result.block)
      openEdit(result.block.id)
      onBlockIdChange?.(result.block.id)
      refresh()
    },
  })
  const update = useMutation({
    mutationFn: (input: { blockId: string; block: CoreBlockInput }) =>
      system.trpcClient.coreBlocks.update.mutate(input),
    onSuccess: (result) => {
      setSavedBlock(result.block)
      openEdit(result.block.id)
      onBlockIdChange?.(result.block.id)
      refresh()
    },
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
      setSavedBlock(null)
      refresh()
      onOpenScripts(result.block.id)
    },
  })

  const all = blocksQuery.data
  const automations = sortBlocksForDisplay((all ?? []).filter((b) => looksLikeAutomation(b.code)))
  const knowsThereAreNone = all !== undefined && automations.length === 0

  const editingFromUrl =
    formState.mode === 'edit'
      ? (automations.find((b) => b.id === formState.id) ??
        (savedBlock !== null && savedBlock.id === formState.id ? savedBlock : null))
      : null
  const editing =
    formState.mode === 'new'
      ? null
      : editingFromUrl !== null
        ? freshest(automations, editingFromUrl)
        : null
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
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Row actions',
        render: (block) => {
          const recipe = parseRecipeFromCode(block.code)
          return (
            <AutomationActions
              block={block}
              busy={setEnabled.isPending || remove.isPending}
              unreadable={recipe.ok ? null : recipe.reason}
              onEdit={() => {
                setSavedBlock(block)
                openEdit(block.id)
                onBlockIdChange?.(block.id)
              }}
              onToggle={(enabled) => setEnabled.mutate({ blockId: block.id, enabled })}
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
    [confirm, logsFor, onBlockIdChange, openEdit, remove, setEnabled, t],
  )

  if (editingOpen) {
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
            setSavedBlock(null)
            closeForm()
            onBlockIdChange?.(null)
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
        <AutomationEmptyState
          onCreate={() => {
            setSavedBlock(null)
            openNew()
            onBlockIdChange?.(null)
          }}
        />
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
          onRowClick={(block) => {
            setSavedBlock(block)
            openEdit(block.id)
            onBlockIdChange?.(block.id)
          }}
        />
      )}

      {remove.error != null && <ErrorBox message={errorMessage(remove.error)} />}
      {setEnabled.error != null && <ErrorBox message={errorMessage(setEnabled.error)} />}
    </div>
  )
}
