/**
 * Scripts — the operator's view of core blocks.
 *
 * A block is user-authored TypeScript the kernel runs in its own process. The
 * one thing this surface must never do is let a block be quietly absent: the
 * status rules in `core-block-status.ts` treat an ENABLED block that is not
 * running as an error even when the stored status says `stopped`, sort the
 * broken ones first, and put "N NOT running" in the header so a failure is read
 * before any row is.
 *
 * **The loop is Compile → Save → Restart → Logs, and there is no Test button.**
 * A block's contract is `export default (ctx) => disposer`, so there is no pure
 * function to call: "test" would necessarily mean *run it*, with real side
 * effects on the real cluster, and the only way to make that feel safe would be
 * a faked `ctx` — which this repo has paid for twice. Compile answers "does it
 * type-check" without saving, Save+Restart answers "does it run", Logs answers
 * "what did it do". (Design §3.1.1, closed 2026-08-08.)
 *
 * Logs cost nothing new: a block's runner id IS `core-block-<id>`, and
 * `LogStream` already scopes by `addonId`. No cap, no store, no component.
 *
 * Polled rather than pushed. The supervisor converges every 15s and a write
 * converges immediately, so a status here is at most one poll behind — and D8
 * says an event may be dropped, which is precisely the case where an operator
 * would otherwise be looking at a green row for a dead process.
 */

import {
  type CoreBlock,
  type CoreBlockInput,
  coreBlockAddonId,
  coreBlockSourceKind,
} from '@camstack/types'
import {
  Badge,
  Button,
  DataTable,
  ErrorBox,
  formatLastSeen,
  ItemFormDialog,
  LogStream,
  TABLE_SCROLL_MAX_H,
  useItemFormUrl,
  useSystem,
  type DataColumn,
  useUiText,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Code2, RotateCw, ScrollText, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BlockEditor, type BlockTypeLibs } from './BlockEditor'
import {
  badgeVariantForTone,
  describeBlockStatus,
  freshest,
  sortBlocksForDisplay,
  summariseBlocks,
} from './core-block-status'
import { Trans, useTranslation } from 'react-i18next'

const BLOCKS_KEY = ['coreBlocks', 'list'] as const
const TYPEDEFS_KEY = ['coreBlocks', 'getTypeDefs'] as const

/** One poll per 5s. Faster than the 15s converge so a state change is visible
 *  within a pass, slow enough that an idle page is not a load. */
const POLL_MS = 5_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported so the rule stays pinned where its test already points: which of
 *  the two views of a block wins decides whether Restart is offered right after
 *  a save. It lives in `core-block-status` because the automations editor needs
 *  exactly the same rule. */
export { freshest } from './core-block-status'

export interface ScriptsTabProps {
  /**
   * A block to open on arrival.
   *
   * Set when an automation was just EJECTED and the operator was sent here to
   * take ownership of the code. Applied at most once per id: a stale `?block=`
   * left in the URL must not keep re-opening the editor over whatever the
   * operator does next.
   */
  readonly initialBlockId?: string
  /** Keep `?block=` in sync with the open editor (null when closed / new). */
  readonly onBlockIdChange?: (blockId: string | null) => void
  /** Header "New script" from Build page — open the editor once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

export function ScriptsTab({
  initialBlockId,
  onBlockIdChange,
  createRequested = false,
  onCreateConsumed,
}: ScriptsTabProps = {}) {
  const uiText = useUiText()
  const { t } = useTranslation()
  const system = useSystem()
  /** `?block=` for edit; `?new=1` for create — same contract as ItemFormDialog. */
  const {
    state: formState,
    openNew,
    openEdit,
    close: closeForm,
  } = useItemFormUrl({ editKey: 'block', newKey: 'new' })
  /** Local draft after create before the list poll catches up (null = new). */
  const [savedBlock, setSavedBlock] = useState<CoreBlock | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  /** Which row has its logs open. One at a time: two live subscriptions in a
   *  list is a lot of socket for a pane nobody is reading. */
  const [logsFor, setLogsFor] = useState<string | null>(null)

  const blocksQuery = useQuery({
    queryKey: BLOCKS_KEY,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<readonly CoreBlock[]> => {
      const result = await system.trpcClient.coreBlocks.list.query({})
      return result.blocks
    },
  })

  const editingOpen = formState.mode !== 'closed'

  // Fetched once and held: 3.4 MB of declaration files cannot change without
  // the node restarting, and re-fetching them per editor open would make
  // opening a script feel broken.
  const typeDefsQuery = useQuery({
    queryKey: TYPEDEFS_KEY,
    enabled: editingOpen,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: (): Promise<BlockTypeLibs> => system.trpcClient.coreBlocks.getTypeDefs.query({}),
  })

  const refresh = (): void => {
    void blocksQuery.refetch()
  }

  const openedFor = useRef<string | null>(null)
  const listed = blocksQuery.data
  useEffect(() => {
    if (initialBlockId === undefined || openedFor.current === initialBlockId) return
    const target = listed?.find((b) => b.id === initialBlockId && coreBlockSourceKind(b) === 'code')
    if (target === undefined) return
    openedFor.current = initialBlockId
    openEdit(initialBlockId)
    onBlockIdChange?.(initialBlockId)
  }, [initialBlockId, listed, openEdit, onBlockIdChange])

  useEffect(() => {
    if (!createRequested) return
    setSavedBlock(null)
    openNew()
    onBlockIdChange?.(null)
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed, onBlockIdChange, openNew])

  const create = useMutation({
    mutationFn: (block: CoreBlockInput) => system.trpcClient.coreBlocks.create.mutate({ block }),
    onSuccess: (result) => {
      // The editor stays open on the block that was just created — the loop is
      // Compile → Save → Restart → Logs, and closing here would break it after
      // the first step.
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
      // Stay in the editor on an EDIT: the operator's next move is Restart, and
      // Restart is only honest once Save has accepted the code that is on
      // screen. Closing here would send them back to the list to re-open it.
      setSavedBlock(result.block)
      openEdit(result.block.id)
      onBlockIdChange?.(result.block.id)
      refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (blockId: string) => system.trpcClient.coreBlocks.delete.mutate({ blockId }),
    onSuccess: () => {
      setConfirmDelete(null)
      refresh()
    },
  })
  const setEnabled = useMutation({
    mutationFn: (input: { blockId: string; enabled: boolean }) =>
      system.trpcClient.coreBlocks.setEnabled.mutate(input),
    onSuccess: refresh,
  })
  const restart = useMutation({
    mutationFn: (blockId: string) => system.trpcClient.coreBlocks.restart.mutate({ blockId }),
    onSuccess: refresh,
  })

  /**
   * Scripts only — composition/recipe blocks belong on Custom Device /
   * Automations. Absent `source` is legacy code (D659). Listing compositions
   * here made two empty `code:''` rows look like broken scripts.
   */
  const blocks = sortBlocksForDisplay(
    (blocksQuery.data ?? []).filter((b) => coreBlockSourceKind(b) === 'code'),
  )
  /**
   * Whether a read actually SUCCEEDED — not whether the array is short.
   *
   * A failed read has no blocks either, and rendering "No scripts yet." over it
   * states as fact the one thing that is unknown. This repo has destroyed and
   * hidden state twice by treating an empty read as "there is nothing"; here it
   * would only mislead, which is still enough.
   */
  const knowsThereAreNone = blocksQuery.data !== undefined && blocks.length === 0
  const saving = create.isPending || update.isPending
  const saveError =
    create.error !== null
      ? errorMessage(create.error)
      : update.error !== null
        ? errorMessage(update.error)
        : null

  /**
   * The row the editor is bound to: the FRESHER of the polled list entry and
   * the block the last write returned.
   *
   * Neither alone is right. The list is what moves the status badge, so a
   * frozen copy would read `starting` forever. But the list is up to one poll
   * behind a save — and the editor gates Restart on "does the screen match what
   * the server stored", so a stale row would keep Restart refused for five
   * seconds after a successful save, telling the operator their save did not
   * take. `updatedAt` is the tiebreak, and it is the server's own stamp.
   */
  const editingFromUrl =
    formState.mode === 'edit'
      ? (blocks.find((b) => b.id === formState.id) ??
        (savedBlock !== null && savedBlock.id === formState.id ? savedBlock : null))
      : null
  const editing =
    formState.mode === 'new'
      ? null
      : editingFromUrl !== null
        ? freshest(blocks, editingFromUrl)
        : null

  const columns: DataColumn<CoreBlock>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('build.scriptsTab.name', 'Name'),
        render: (block) => {
          const status = describeBlockStatus(block)
          const edited = formatLastSeen(block.updatedAt, uiText)
          return (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{block.name}</span>
                <Badge variant={badgeVariantForTone(status.tone)}>{status.label}</Badge>
                <Badge variant="info">{block.placement}</Badge>
                {edited !== null && (
                  <span className="text-xs text-foreground-subtle">
                    {t('common.edited', { when: edited })}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-foreground-subtle">{status.detail}</p>
              {logsFor === block.id && (
                <div className="mt-2 rounded border border-border">
                  <div className="border-b border-border px-3 py-1.5 text-xs text-foreground-subtle">
                    <Trans
                      i18nKey="common.logsOf"
                      values={{ id: coreBlockAddonId(block.id) }}
                      components={{ code: <code /> }}
                    />
                  </div>
                  <LogStream
                    addonId={coreBlockAddonId(block.id)}
                    maxHeight="max-h-64"
                    showFilters={false}
                  />
                </div>
              )}
            </div>
          )
        },
        sortValue: (block) => block.name,
        nowrap: false,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: 'Row actions',
        render: (block) => {
          const busy = setEnabled.isPending || remove.isPending
          const restarting = restart.isPending && restart.variables === block.id
          if (confirmDelete === block.id) {
            return (
              <div className="flex justify-end gap-1">
                <span className="text-xs text-foreground-subtle">
                  {t('build.scriptsTab.deleteThisScript', 'Delete this script?')}
                </span>
                <Button variant="danger" onClick={() => remove.mutate(block.id)} disabled={busy}>
                  {t('common.delete', 'Delete')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            )
          }
          return (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setSavedBlock(block)
                  openEdit(block.id)
                  onBlockIdChange?.(block.id)
                }}
                title={t('common.edit', 'Edit')}
              >
                {t('common.edit', 'Edit')}
              </Button>
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  restart.mutate(block.id)
                }}
                disabled={busy || restarting || !block.enabled}
                title={
                  block.enabled
                    ? t('build.scriptsTab.restart', 'Restart')
                    : t(
                        'build.scriptsTab.enableItInsteadADisabled',
                        'Enable it instead — a disabled script has no process',
                      )
                }
              >
                <RotateCw className={`h-4 w-4${restarting ? ' animate-spin' : ''}`} />
              </Button>
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setLogsFor(logsFor === block.id ? null : block.id)
                }}
                title={t('build.scriptsTab.logs', 'Logs')}
              >
                <ScrollText className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setEnabled.mutate({
                    blockId: block.id,
                    enabled: !block.enabled,
                  })
                }}
                disabled={busy}
                title={
                  block.enabled ? t('common.disable', 'Disable') : t('common.enable', 'Enable')
                }
              >
                {block.enabled ? t('common.disable', 'Disable') : t('common.enable', 'Enable')}
              </Button>
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(block.id)
                }}
                title={t('common.delete', 'Delete')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )
        },
      },
    ],
    [
      confirmDelete,
      logsFor,
      onBlockIdChange,
      openEdit,
      remove,
      restart.isPending,
      restart.variables,
      setEnabled,
      t,
    ],
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        {blocksQuery.data === undefined ? '' : summariseBlocks(blocks)}
      </p>

      {blocksQuery.error != null && (
        <ErrorBox
          title={t('build.scriptsTab.couldNotReadTheScripts', 'Could not read the scripts')}
          message={errorMessage(blocksQuery.error)}
          onRetry={refresh}
        />
      )}

      <DataTable
        columns={columns}
        rows={blocks}
        rowKey={(b) => b.id}
        pageSize={25}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        emptyMessage={
          knowsThereAreNone
            ? t(
                'build.scriptsTab.noScriptsYetAScript',
                'No scripts yet. A script is TypeScript the hub runs in its own process.',
              )
            : blocksQuery.data === undefined
              ? t('build.scriptsTab.loadingScripts', 'Loading scripts…')
              : t('build.scriptsTab.noScriptsYet', 'No scripts yet.')
        }
        onRowClick={(block) => {
          setSavedBlock(block)
          openEdit(block.id)
          onBlockIdChange?.(block.id)
        }}
      />

      <ItemFormDialog
        open={editingOpen}
        onClose={() => {
          create.reset()
          update.reset()
          restart.reset()
          setSavedBlock(null)
          closeForm()
          onBlockIdChange?.(null)
        }}
        title={
          editing !== null
            ? t('build.scriptsTab.edit', 'Edit {{name}}', { name: editing.name })
            : t('build.scriptsTab.newScript', 'New script')
        }
        icon={Code2}
        width="xl"
        testId="script-editor-panel"
      >
        <BlockEditor
          existing={editing}
          typeDefs={typeDefsQuery.data}
          typeDefsLoading={typeDefsQuery.isLoading}
          saving={saving}
          saveError={saveError}
          restarting={restart.isPending}
          restartError={restart.error !== null ? errorMessage(restart.error) : null}
          onRestart={editing !== null ? () => restart.mutate(editing.id) : undefined}
          onSave={(input) => {
            const target = editing
            if (target === null) create.mutate(input)
            else update.mutate({ blockId: target.id, block: input })
          }}
          onCancel={() => {
            create.reset()
            update.reset()
            restart.reset()
            setSavedBlock(null)
            closeForm()
            onBlockIdChange?.(null)
          }}
        />
      </ItemFormDialog>

      {remove.error != null && <ErrorBox message={errorMessage(remove.error)} />}
      {setEnabled.error != null && <ErrorBox message={errorMessage(setEnabled.error)} />}
      {restart.error != null && <ErrorBox message={errorMessage(restart.error)} />}
    </div>
  )
}
