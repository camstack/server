import type { UninstallPackageResult } from '@camstack/types'
import {
  useAddonsListInstallations,
  useAddonsUninstallPackage,
  useAlert,
  useConfirm,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Globe, Trash2 } from 'lucide-react'
import {
  everywhereConfirmMessage,
  holdersOf,
  nodeConfirmMessage,
  resultMessage,
} from './uninstall-text'
import { useTranslation } from 'react-i18next'

/** The node the Addons page is scoped to — `SelectableNode`'s relevant subset. */
export interface UninstallTargetNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
}

export interface AddonUninstallControlsProps {
  readonly packageName: string
  readonly displayName: string
  readonly selectedNode: UninstallTargetNode
  /** Hide "uninstall from this node" — e.g. the hub row of a package the hub lacks. */
  readonly hideNodeAction?: boolean
  readonly disabled?: boolean
}

/** The page-wide installations query input — shared with `NodeOnlyPackagesPanel`. */
export const ALL_PACKAGES = {} as const
export const INSTALLATIONS_STALE_MS = 30_000

const BUTTON =
  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium border border-border text-foreground-subtle hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 disabled:opacity-50 transition-colors'

/**
 * Per-node and cluster-wide uninstall for one package (`addons.uninstallPackage`
 * with `nodeId` / `everywhere`). "Uninstall" removes it from the node the page
 * is scoped to; "Everywhere" from every node that has it, after a confirm that
 * names them. Each node's outcome is shown afterwards — a refusal or a failure
 * on one node is reported, never folded into a success.
 */
export function AddonUninstallControls({
  packageName,
  displayName,
  selectedNode,
  hideNodeAction,
  disabled,
}: AddonUninstallControlsProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const alert = useAlert()
  // ONE cluster-wide read for the whole page: every card and the "not on the
  // hub" panel share this query key, so the hub fans out to the agents once,
  // not once per card.
  const installationsQuery = useAddonsListInstallations(ALL_PACKAGES, {
    staleTime: INSTALLATIONS_STALE_MS,
  })
  const installations = installationsQuery.data?.installations ?? []
  const unreachable = (installationsQuery.data?.unreachable ?? []).map((u) => u.nodeId)
  const holders = holdersOf(installations, packageName)
  const nameOf = (nodeId: string): string =>
    holders.find((h) => h.nodeId === nodeId)?.nodeName ??
    (nodeId === selectedNode.id ? selectedNode.name : nodeId)

  const mutation = useAddonsUninstallPackage({
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [['addons']] })
      void queryClient.invalidateQueries({ queryKey: [['addonPages']] })
      void queryClient.invalidateQueries({ queryKey: [['capabilities']] })
      void queryClient.invalidateQueries({ queryKey: [['nodes']] })
    },
  })

  const report = async (result: UninstallPackageResult): Promise<void> => {
    await alert({
      title: result.success
        ? t('addons.addonUninstallControls.uninstalled', '{{displayName}} uninstalled', {
            displayName,
          })
        : t(
            'addons.addonUninstallControls.notEveryNodeWasCleaned',
            '{{displayName}}: not every node was cleaned',
            { displayName },
          ),
      message: resultMessage(result, nameOf),
      variant: result.success ? 'default' : 'danger',
    })
  }

  const run = async (input: {
    readonly nodeId?: string
    readonly everywhere?: boolean
  }): Promise<void> => {
    try {
      const result = await mutation.mutateAsync({ packageName, ...input })
      await report(result)
    } catch (err) {
      await alert({
        title: t(
          'addons.addonUninstallControls.uninstallFailed',
          'Uninstall {{displayName}} failed',
          { displayName },
        ),
        message: err instanceof Error ? err.message : String(err),
        variant: 'danger',
      })
    }
  }

  const onNode = async (): Promise<void> => {
    const others = holders.filter((h) => h.nodeId !== selectedNode.id)
    const ok = await confirm({
      title: t(
        'addons.addonUninstallControls.uninstallFrom',
        'Uninstall {{displayName}} from {{name}}?',
        { displayName, name: selectedNode.name },
      ),
      message: nodeConfirmMessage(displayName, selectedNode.name, others),
      confirmLabel: t('addons.addonUninstallControls.uninstall', 'Uninstall'),
      variant: 'danger',
    })
    if (ok) await run(selectedNode.isHub ? {} : { nodeId: selectedNode.id })
  }

  const onEverywhere = async (): Promise<void> => {
    // Ask again at click time: the confirm must name the nodes as they are NOW.
    const fresh = await installationsQuery.refetch()
    const now = fresh.data
    if (now === undefined) {
      await alert({
        title: t('addons.addonUninstallControls.cannotListTheNodes', 'Cannot list the nodes'),
        message: t(
          'addons.addonUninstallControls.theHubDidNotAnswer',
          'The hub did not answer which nodes have this package — nothing was removed.',
        ),
        variant: 'danger',
      })
      return
    }
    const nowHolders = holdersOf(now.installations, packageName)
    const ok = await confirm({
      title: t(
        'addons.addonUninstallControls.uninstallEverywhere',
        'Uninstall {{displayName}} everywhere?',
        { displayName },
      ),
      message: everywhereConfirmMessage(
        displayName,
        nowHolders,
        now.unreachable.map((u) => u.nodeId),
      ),
      confirmLabel: t(
        'addons.addonUninstallControls.uninstallFromNodeS',
        'Uninstall from {{length}} node(s)',
        { length: nowHolders.length },
      ),
      variant: 'danger',
    })
    if (ok) await run({ everywhere: true })
  }

  const busy = mutation.isPending || disabled === true
  return (
    <div className="flex items-center gap-1.5">
      {hideNodeAction !== true && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void onNode()
          }}
          disabled={busy}
          className={BUTTON}
          title={t('addons.addonUninstallControls.uninstallFrom2', 'Uninstall from {{name}}', {
            name: selectedNode.name,
          })}
        >
          <Trash2 className="h-3 w-3" />
          {mutation.isPending
            ? t('addons.addonUninstallControls.removing', 'Removing...')
            : t('addons.addonUninstallControls.uninstall', 'Uninstall')}
        </button>
      )}
      {(holders.length > 1 || hideNodeAction === true || unreachable.length > 0) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void onEverywhere()
          }}
          disabled={busy}
          className={BUTTON}
          title={t(
            'addons.addonUninstallControls.uninstallFromEveryNodeThat',
            'Uninstall from every node that has it',
          )}
        >
          <Globe className="h-3 w-3" />
          {holders.length > 0
            ? t('addons.uninstallControls.everywhereCount', { count: holders.length })
            : t('addons.uninstallControls.everywhere')}
        </button>
      )}
    </div>
  )
}
