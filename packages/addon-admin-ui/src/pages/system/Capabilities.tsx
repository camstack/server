/**
 * Capabilities (Bindings) page — operator UI for choosing which provider
 * is active for each system capability.
 *
 * Two addons can register for the same capability (e.g. `webrtc-session` is
 * provided by both `webrtc-native` and `stream-broker`). Previously the only
 * way to switch the active provider was the raw tRPC API; this page surfaces
 * it:
 *   - singleton caps: a radio list — selecting a provider calls
 *     `capabilities.setActiveSingleton` (the runtime swap takes effect, and the
 *     choice is persisted so it survives a reboot).
 *   - collection caps: enable/disable checkboxes — toggling sends the FULL
 *     desired enabled set to `capabilities.setCollectionEnabledProviders`.
 *
 * Admin-only (the underlying procedures are `adminProcedure`s and the route is
 * wrapped in `<ProtectedRoute requireAdmin>`).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { SlidersHorizontal, CheckCircle, AlertCircle } from 'lucide-react'
import type { CapabilityInfo } from '@camstack/types'
import { ErrorBox, useSystem } from '@camstack/ui-library'
import { AdminPage } from '../../components/AdminPage'
import {
  CapabilityMap,
  type CapabilityEntry,
  type CapabilityMode,
} from '../../components/addons/CapabilityMap'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const CAPABILITIES_QUERY_KEY = ['capabilities', 'listCapabilities'] as const

/**
 * This page manages the two selectable cap modes only. `per-node` caps (the
 * third `CapabilityMode`) have no select/toggle procedure on the capabilities
 * router, so they're filtered out of the listing rather than rendered as
 * inert cards.
 */
function isSelectableMode(mode: CapabilityInfo['mode']): mode is CapabilityMode {
  return mode === 'singleton' || mode === 'collection'
}

/**
 * Map the registry's `CapabilityInfo` (addon IDs only) into the
 * `CapabilityEntry` shape `CapabilityMap` renders. The registry returns plain
 * addon IDs (already human-readable, e.g. `webrtc-native`) so we use the ID as
 * the display name. `active` is derived per mode: for singletons it's the
 * `activeProvider`; for collections it's "registered AND not disabled".
 */
/**
 * Format a provider id for display. The registry keys hub-local children by
 * the bare addonId and remote-agent providers by `addonId@nodeId` (the
 * Moleculer registry keying), so surface the node explicitly:
 *   `detection-pipeline@dev-agent-0` → "detection-pipeline (dev-agent-0)"
 *   `stream-broker`                  → "stream-broker (hub)"
 */
function formatProviderName(addonId: string): string {
  const at = addonId.indexOf('@')
  return at === -1
    ? i18n.t('system.capabilities.providerHub', { addonId })
    : `${addonId.slice(0, at)} (${addonId.slice(at + 1)})`
}

function toEntry(info: CapabilityInfo, mode: CapabilityMode): CapabilityEntry {
  return {
    name: info.name,
    mode,
    providers: info.providers.map((addonId) => ({
      addonId,
      addonName: formatProviderName(addonId),
      active:
        mode === 'singleton'
          ? info.activeProvider === addonId
          : !info.disabledProviders.includes(addonId),
    })),
    ...(mode === 'singleton' && info.perNode ? { perNode: info.perNode } : {}),
  }
}

interface FeedbackState {
  readonly kind: 'success' | 'error'
  readonly message: string
}

export function CapabilitiesPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [pendingCapability, setPendingCapability] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<FeedbackState | null>(null)

  const query = useQuery({
    queryKey: CAPABILITIES_QUERY_KEY,
    queryFn: (): Promise<readonly CapabilityInfo[]> =>
      system.trpcClient.capabilities.listCapabilities.query(),
  })

  // Singletons first, each group sorted by name — singletons are the
  // "pick one provider" decisions an operator most often reaches for
  // (e.g. swapping the WebRTC backend), so they lead.
  const entries = useMemo<readonly CapabilityEntry[]>(() => {
    const all = (query.data ?? []).flatMap((info): CapabilityEntry[] =>
      isSelectableMode(info.mode) ? [toEntry(info, info.mode)] : [],
    )
    const singletons = all
      .filter((e) => e.mode === 'singleton')
      .toSorted((a, b) => a.name.localeCompare(b.name))
    const collections = all
      .filter((e) => e.mode === 'collection')
      .toSorted((a, b) => a.name.localeCompare(b.name))
    return [...singletons, ...collections]
  }, [query.data])

  const singletonEntries = useMemo(() => entries.filter((e) => e.mode === 'singleton'), [entries])
  const collectionEntries = useMemo(() => entries.filter((e) => e.mode === 'collection'), [entries])

  const setSingleton = useMutation({
    mutationFn: (vars: { capName: string; addonId: string }) =>
      system.trpcClient.capabilities.setActiveSingleton.mutate({
        capability: vars.capName,
        addonId: vars.addonId,
      }),
    onMutate: (vars) => {
      setPendingCapability(vars.capName)
      setFeedback(null)
    },
    onSuccess: async (_data, vars) => {
      setFeedback({
        kind: 'success',
        message: t('system.capabilities.isNowActive', '{{capName}} → {{addonId}} is now active.', {
          capName: vars.capName,
          addonId: vars.addonId,
        }),
      })
      await query.refetch()
    },
    onError: (err: unknown, vars) => {
      setFeedback({
        kind: 'error',
        message: t('system.capabilities.failedToSet', {
          cap: vars.capName,
          error: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      })
    },
    onSettled: () => setPendingCapability(null),
  })

  const setNodeSingleton = useMutation({
    mutationFn: (vars: { capName: string; addonId: string; nodeId: string }) =>
      system.trpcClient.capabilities.setActiveSingleton.mutate({
        capability: vars.capName,
        addonId: vars.addonId,
        nodeId: vars.nodeId,
      }),
    onMutate: (vars) => {
      setPendingCapability(vars.capName)
      setFeedback(null)
    },
    onSuccess: async (_data, vars) => {
      setFeedback({
        kind: 'success',
        message: `${vars.capName} @ ${vars.nodeId} → ${vars.addonId}.`,
      })
      await query.refetch()
    },
    onError: (err: unknown, vars) => {
      setFeedback({
        kind: 'error',
        message: t('system.capabilities.failedToSetOnNode', {
          cap: vars.capName,
          node: vars.nodeId,
          error: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      })
    },
    onSettled: () => setPendingCapability(null),
  })

  const clearNodeSingleton = useMutation({
    mutationFn: (vars: { capName: string; nodeId: string }) =>
      system.trpcClient.capabilities.clearSingletonNodeOverride.mutate({
        capability: vars.capName,
        nodeId: vars.nodeId,
      }),
    onMutate: (vars) => {
      setPendingCapability(vars.capName)
      setFeedback(null)
    },
    onSuccess: async (_data, vars) => {
      setFeedback({
        kind: 'success',
        message: t(
          'system.capabilities.nowInheritsTheGlobalDefault',
          '{{capName}} @ {{nodeId}} now inherits the global default.',
          { capName: vars.capName, nodeId: vars.nodeId },
        ),
      })
      await query.refetch()
    },
    onError: (err: unknown, vars) => {
      setFeedback({
        kind: 'error',
        message: t('system.capabilities.failedToClearOnNode', {
          cap: vars.capName,
          node: vars.nodeId,
          error: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      })
    },
    onSettled: () => setPendingCapability(null),
  })

  const setCollection = useMutation({
    mutationFn: (vars: { capName: string; enabledAddonIds: readonly string[] }) =>
      system.trpcClient.capabilities.setCollectionEnabledProviders.mutate({
        capability: vars.capName,
        enabledAddonIds: [...vars.enabledAddonIds],
      }),
    onMutate: (vars) => {
      setPendingCapability(vars.capName)
      setFeedback(null)
    },
    onSuccess: async (_data, vars) => {
      setFeedback({
        kind: 'success',
        message: t(
          'system.capabilities.providerSEnabled',
          '{{capName}}: {{length}} provider(s) enabled.',
          { capName: vars.capName, length: vars.enabledAddonIds.length },
        ),
      })
      await query.refetch()
    },
    onError: (err: unknown, vars) => {
      setFeedback({
        kind: 'error',
        message: t('system.capabilities.failedToUpdate', {
          cap: vars.capName,
          error: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      })
    },
    onSettled: () => setPendingCapability(null),
  })

  const actions = {
    onSelectSingleton: (capName: string, addonId: string) =>
      setSingleton.mutate({ capName, addonId }),
    onSelectNodeSingleton: (capName: string, nodeId: string, addonId: string) =>
      setNodeSingleton.mutate({ capName, nodeId, addonId }),
    onClearNodeSingleton: (capName: string, nodeId: string) =>
      clearNodeSingleton.mutate({ capName, nodeId }),
    onToggleCollection: (capName: string, enabledAddonIds: readonly string[]) =>
      setCollection.mutate({ capName, enabledAddonIds }),
    pendingCapability,
  }

  return (
    <AdminPage
      embedded
      icon={SlidersHorizontal}
      title={t('system.capabilities.capabilities', 'Capabilities')}
      subtitle={t(
        'system.capabilities.chooseWhichProviderIsActive',
        'Choose which provider is active for each system capability. Singleton caps pick exactly one provider; collection caps enable a set.',
      )}
    >
      {feedback && (
        <div
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
            feedback.kind === 'success'
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {feedback.kind === 'success' ? (
            <CheckCircle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {query.isLoading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      )}

      {query.isError && !query.isLoading && (
        <ErrorBox
          title={t('system.capabilities.failedToLoadCapabilities', 'Failed to load capabilities')}
          message={
            query.error instanceof Error
              ? query.error.message
              : t('system.capabilities.unknownError', 'Unknown error')
          }
          onRetry={() => void query.refetch()}
        />
      )}

      {!query.isLoading && !query.isError && entries.length === 0 && (
        <div className="text-xs text-foreground-subtle text-center py-16">
          {t('system.capabilities.noCapabilitiesRegistered', 'No capabilities registered.')}
        </div>
      )}

      {!query.isLoading && !query.isError && entries.length > 0 && (
        <div className="space-y-6">
          {singletonEntries.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-subtle/70">
                {t('system.capabilities.singletonPickOneProvider', 'Singleton — pick one provider')}
              </h2>
              <CapabilityMap capabilities={singletonEntries} actions={actions} />
            </section>
          )}
          {collectionEntries.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-subtle/70">
                {t('system.capabilities.collectionEnableASet', 'Collection — enable a set')}
              </h2>
              <CapabilityMap capabilities={collectionEntries} actions={actions} />
            </section>
          )}
        </div>
      )}
    </AdminPage>
  )
}

export default CapabilitiesPage
