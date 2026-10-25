/**
 * Per-node server-management section — the runtime-updatable root package
 * (`@camstack/server` for every node; hub vs agent is the CAMSTACK_ROLE, not a
 * different package) status + lifecycle actions (check / update / restart) for
 * a SINGLE node.
 *
 * NO rollback surface. The single-framework-copy collapse (2026-07-18) removed
 * probation boot, N-1 retention and auto-rollback: `RootUpdateService` now
 * hardcodes `previousVersion: null`, `rolledBack: null` and
 * `stateFileCorrupt: false`, and never reports `awaiting-confirmation`. The
 * rows, banners and the rollback button that consumed those fields could
 * therefore never render — and the confirm copy still promised an automatic
 * rollback that no longer happens.
 *
 * Extracted from the former standalone Server-management page so the same
 * per-node surface renders inside the Cluster node card's General tab. The
 * cluster-wide "Update all nodes" convenience lives on the Cluster page top
 * bar (a global action, not a per-node one).
 *
 * Per-node actions ride the standard singleton `nodeId` routing: the hub is
 * the unpinned default provider (`routingInput = undefined`), agents are
 * `nodeId`-pinned. The status query is gated on `node.isOnline`.
 */
import type { ServerUpdateActionResult } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, HardDriveDownload, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useConfirm,
  useServerManagementApplyServerUpdate,
  useServerManagementCheckServerUpdate,
  useServerManagementGetServerPackageStatus,
  useServerManagementRestartServer,
} from '@camstack/ui-library'

const STATUS_QUERY_KEY = [['serverManagement', 'getServerPackageStatus']] as const

interface BadgeProps {
  readonly label: string
  readonly tone: 'neutral' | 'ok' | 'info' | 'warn' | 'error'
}

function Badge({ label, tone }: BadgeProps) {
  const tones: Record<BadgeProps['tone'], string> = {
    neutral: 'bg-surface-muted text-foreground-subtle',
    ok: 'bg-success/15 text-success',
    info: 'bg-info/15 text-info',
    warn: 'bg-warning/15 text-warning',
    error: 'bg-danger/15 text-danger',
  }
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {label}
    </span>
  )
}

interface VersionRowProps {
  readonly label: string
  readonly value: string | null
}

function VersionRow({ label, value }: VersionRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono text-foreground">{value ?? '—'}</span>
    </div>
  )
}

interface VersionProspectusProps {
  readonly runningVersion: string | null
  readonly latestVersion: string | null
  readonly seedVersion: string | null
  readonly nodeRuntimeVersion: string | null
  readonly labelRunning: string
  readonly labelLatest: string
  readonly labelSeed: string
  readonly labelRuntime: string
}

/** Running / latest / seed / Node.js on one wrapped line — not four stacked rows. */
function VersionProspectus({
  runningVersion,
  latestVersion,
  seedVersion,
  nodeRuntimeVersion,
  labelRunning,
  labelLatest,
  labelSeed,
  labelRuntime,
}: VersionProspectusProps) {
  const segments: readonly {
    readonly key: string
    readonly label: string
    readonly value: string | null
  }[] = [
    { key: 'running', label: labelRunning, value: runningVersion },
    { key: 'latest', label: labelLatest, value: latestVersion },
    { key: 'seed', label: labelSeed, value: seedVersion },
    { key: 'runtime', label: labelRuntime, value: nodeRuntimeVersion },
  ]
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {segments.map(({ key, label, value }) => (
        <span key={key} className="inline-flex items-baseline gap-1">
          <span className="text-foreground-subtle">{label}</span>
          <span className="font-mono text-foreground">{value ?? '—'}</span>
        </span>
      ))}
    </div>
  )
}

const OUTCOME_CLASSES: Record<ActionOutcome['tone'], string> = {
  ok: 'border-success/40 bg-success/10 text-success',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-danger/40 bg-danger/10 text-danger',
}

/** The last action's answer, as rendered. */
interface ActionOutcome {
  readonly tone: 'ok' | 'warn' | 'error'
  readonly text: string
}

/**
 * Tone from what the node said it DID, not from `accepted` alone. A staging
 * install that died on the registry (`failed`) is red; a gate that declined
 * (`refused`) or a target already running (`already-current`) is amber; a
 * provider too old to say (`outcome` absent) falls back to the boolean.
 */
function outcomeTone(result: ServerUpdateActionResult): ActionOutcome['tone'] {
  if (result.outcome === 'failed') return 'error'
  if (result.outcome !== undefined) return result.accepted ? 'ok' : 'warn'
  return result.accepted ? 'ok' : 'warn'
}

/** Translator shape used by {@link describeDroppedCall} (named type per house rules). */
type Translate = (key: string, fallback: string) => string

/**
 * A dropped call is NOT a success and NOT a failure.
 *
 * The node we just armed restarting, and a forward that timed out because the
 * node was wedged, are the same rejection here. Claiming either is the mistake
 * the cluster-wide loop made; per node the operator can simply re-read the
 * card, so the honest sentence is enough.
 */
function describeDroppedCall(t: Translate, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  // The transport's own words are APPENDED rather than interpolated into the
  // translated sentence: the error text is the diagnostic half, and it must
  // survive regardless of how the locale renders the prose around it.
  const prose = t(
    'serverManagement.outcomeDropped',
    'The connection dropped and the result could not be confirmed. The node may be restarting — re-check the version above.',
  )
  return `${prose} — ${detail}`
}

/** The cluster-node slice this section consumes (named type per house rules). */
export interface ServerManagementNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly rootPackage: { readonly name: string; readonly version: string } | null
}

interface NodeServerManagementSectionProps {
  readonly node: ServerManagementNode
}

export function NodeServerManagementSection({ node }: NodeServerManagementSectionProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [restarting, setRestarting] = useState(false)
  /**
   * The node's own answer to the last action. Null until one is taken — but
   * NEVER null merely because the answer was "no": a refusal or a dropped call
   * is exactly what this exists to show.
   */
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null)

  // Hub = the unpinned default provider; agents = nodeId-pinned routing.
  const routingInput = node.isHub ? undefined : { nodeId: node.id }

  const statusQuery = useServerManagementGetServerPackageStatus(routingInput, {
    refetchInterval: 10_000,
    enabled: node.isOnline,
    retry: 1,
  })
  const status = statusQuery.data ?? null

  const invalidateStatus = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
  }, [queryClient])

  const checkMutation = useServerManagementCheckServerUpdate({ onSettled: invalidateStatus })
  const applyMutation = useServerManagementApplyServerUpdate({ onSettled: invalidateStatus })
  const restartMutation = useServerManagementRestartServer({ onSettled: invalidateStatus })

  const handleUpdate = useCallback(async (): Promise<void> => {
    if (status?.latestVersion == null) {
      // A dead click. The guard is right — there is nothing to update to — but
      // returning in silence is how "I pressed it and nothing happened"
      // becomes unanswerable.
      setOutcome({
        tone: 'warn',
        text: t(
          'serverManagement.outcomeNoTarget',
          'No target version is known for this node — run "Check for update" first.',
        ),
      })
      return
    }
    const ok = await confirm({
      title: t('serverManagement.confirmUpdateTitle', 'Update node root package'),
      message: t(
        'serverManagement.confirmUpdateBody',
        'Install {{pkg}}@{{version}} on "{{node}}" and restart to apply.',
        { pkg: status.packageName, version: status.latestVersion, node: node.name },
      ),
      confirmLabel: t('serverManagement.confirmUpdateAction', 'Update & restart'),
    })
    if (!ok) return
    setOutcome(null)
    try {
      const result = await applyMutation.mutateAsync({
        version: status.latestVersion,
        ...routingInput,
      })
      // `message` is the node's own sentence — a refusal reason or the staged
      // confirmation. Reading only `restarting` (what this used to do) threw
      // every refusal away.
      setOutcome({ tone: outcomeTone(result), text: result.message })
      if (result.restarting) setRestarting(true)
    } catch (err) {
      setOutcome({ tone: 'warn', text: describeDroppedCall(t, err) })
    }
  }, [applyMutation, confirm, node.name, routingInput, status, t])

  const handleRestart = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t('serverManagement.confirmRestartTitle', 'Restart node'),
      message: t(
        'serverManagement.confirmRestartBody',
        'Restart "{{node}}"? In-flight requests to this node are dropped.',
        { node: node.name },
      ),
      confirmLabel: t('serverManagement.confirmRestartAction', 'Restart'),
      variant: 'warning',
    })
    if (!ok) return
    setOutcome(null)
    try {
      const result = await restartMutation.mutateAsync(routingInput)
      setOutcome({ tone: outcomeTone(result), text: result.message })
      if (result.restarting) setRestarting(true)
    } catch (err) {
      setOutcome({ tone: 'warn', text: describeDroppedCall(t, err) })
    }
  }, [confirm, node.name, restartMutation, routingInput, t])

  const bootModeBadge = (): BadgeProps => {
    switch (status?.bootMode) {
      case 'data-root':
        return { label: t('serverManagement.bootDataRoot', 'runtime-updatable'), tone: 'ok' }
      case 'workspace':
        return { label: t('serverManagement.bootWorkspace', 'dev workspace'), tone: 'info' }
      default:
        return { label: t('serverManagement.bootBaked', 'baked image seed'), tone: 'neutral' }
    }
  }

  const updateStateBadge = (): BadgeProps | null => {
    if (status == null) return null
    switch (status.updateState) {
      case 'checking':
        return { label: t('serverManagement.stateChecking', 'checking…'), tone: 'info' }
      case 'staging':
        return { label: t('serverManagement.stateStaging', 'updating…'), tone: 'info' }
      case 'pending-restart':
        return { label: t('serverManagement.statePending', 'restart pending'), tone: 'warn' }
      default:
        // Nothing staged, yet the copy on disk is not the code running — the
        // node must not read as "up to date" while a restart would change it.
        if (status.restartRequired === true) {
          return {
            label: t('serverManagement.stateRestartRequired', 'restart required'),
            tone: 'warn',
          }
        }
        return status.updateAvailable
          ? { label: t('serverManagement.stateUpdateAvailable', 'update available'), tone: 'warn' }
          : { label: t('serverManagement.stateUpToDate', 'up to date'), tone: 'ok' }
    }
  }

  const workspaceMode = status?.bootMode === 'workspace'
  const canUpdate =
    node.isOnline &&
    status != null &&
    !workspaceMode &&
    status.updateAvailable &&
    status.updateState === 'idle' &&
    !applyMutation.isPending
  // A plain restart is allowed in any boot mode (dev included), but only when
  // the node is settled: staging / pending-restart carry a version in flight
  // that a bounce would skip.
  const canRestart =
    node.isOnline && status != null && status.updateState === 'idle' && !restartMutation.isPending
  const stateBadge = node.isOnline ? updateStateBadge() : null
  const packageName = status?.packageName ?? node.rootPackage?.name ?? '@camstack/server'

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-foreground-subtle truncate">{packageName}</span>
          {node.isOnline && status != null && <Badge {...bootModeBadge()} />}
        </div>
        {stateBadge != null && <Badge {...stateBadge} />}
      </div>

      {!node.isOnline && (
        <VersionRow
          label={t('serverManagement.lastReportedVersion', 'Last reported version')}
          value={node.rootPackage?.version ?? null}
        />
      )}

      {node.isOnline && statusQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      )}

      {node.isOnline && statusQuery.isError && (
        <div className="space-y-1.5">
          <p className="text-sm text-danger">
            {t('serverManagement.loadError', 'Could not load the node root-package status.')}
          </p>
          {node.rootPackage != null && (
            <VersionRow
              label={t('serverManagement.lastReportedVersion', 'Last reported version')}
              value={node.rootPackage.version}
            />
          )}
        </div>
      )}

      {node.isOnline && status != null && (
        <div className="space-y-1.5">
          <VersionProspectus
            runningVersion={status.runningVersion}
            latestVersion={status.latestVersion}
            seedVersion={status.seedVersion}
            nodeRuntimeVersion={status.nodeRuntimeVersion}
            labelRunning={t('serverManagement.runningVersionShort', 'Running')}
            labelLatest={t('serverManagement.latestVersionShort', 'Latest')}
            labelSeed={t('serverManagement.imageSeedShort', 'Seed')}
            labelRuntime={t('serverManagement.nodeRuntimeVersionShort', 'Node.js')}
          />
          {status.pendingVersion != null && (
            <VersionRow
              label={t('serverManagement.pendingVersion', 'Staged (applies on restart)')}
              value={status.pendingVersion}
            />
          )}
          {status.installedVersion != null && status.installedVersion !== status.runningVersion && (
            <VersionRow
              label={t(
                'serverManagement.installedVersion',
                'Installed on disk (runs after restart)',
              )}
              value={status.installedVersion}
            />
          )}
        </div>
      )}

      {/*
        Image-contract divergence — the fact no surface carried on 2026-08-02,
        when the hub ran a 13-day-old image from a RENAMED repository while
        `runningVersion` (applyServerUpdate) said "up to date". The verdict is
        computed server-side (RootUpdateService → assessImageContract); this
        banner only refuses to let it be missed.

        `behind-patch` is NOT shown (2026-08-27). It means the baked seed is
        behind the contract within the same release series — which is the
        NORMAL, expected state of every node that has ever taken a runtime
        update: applyServerUpdate installs the newer code into the data root
        and by design never touches the image, so the seed is older by
        construction the moment an update lands. The hub sat in `behind-patch`
        continuously (seed 1.2.175 vs contract 1.2.179 on 2026-08-27), so the
        banner was permanent furniture and read as a fault that was not one.

        `behind-series` stays: a full major.minor behind is the shape of a
        pinned tag or a dead image repository, where a docker pull fixes
        nothing. That is the 2026-08-02 failure, it is rare, and it is the only
        one the operator can act on.

        Nothing else changes — `assessImageContract` still computes both states,
        `RootUpdateService` still WARNs on either, and the Home Assistant export
        still publishes `imageContract.state` as a sensor. Only the always-on
        banner is gone.
      */}
      {node.isOnline && status?.imageContract?.state === 'behind-series' && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
          <p className="mb-0.5 font-semibold">
            {t(
              'serverManagement.imageContractDiverged',
              'Container image diverges from the deployment contract',
            )}
          </p>
          <p>{status.imageContract.message}</p>
        </div>
      )}

      {node.isOnline && workspaceMode && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'serverManagement.workspaceNote',
            'Development workspace detected — runtime updates are disabled (the dev loop resolves code from the workspace).',
          )}
        </p>
      )}

      {outcome != null && (
        <p
          role="status"
          className={`rounded border px-2 py-1.5 text-xs leading-relaxed ${OUTCOME_CLASSES[outcome.tone]}`}
        >
          {outcome.text}
        </p>
      )}

      {restarting && (
        <div className="flex items-center gap-2 text-sm text-warning">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('serverManagement.nodeRestarting', 'The node is restarting to apply the change…')}
        </div>
      )}

      {node.isOnline && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
            disabled={checkMutation.isPending || status?.updateState === 'staging'}
            onClick={() => checkMutation.mutate(routingInput)}
          >
            {checkMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('serverManagement.checkForUpdate', 'Check for update')}
          </button>

          {canUpdate && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              onClick={() => void handleUpdate()}
            >
              {applyMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowDownToLine className="h-3.5 w-3.5" />
              )}
              {t('serverManagement.updateTo', 'Update to {{version}}', {
                version: status?.latestVersion ?? '',
              })}
            </button>
          )}

          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
            disabled={!canRestart}
            onClick={() => void handleRestart()}
          >
            {restartMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {t('serverManagement.restart', 'Restart')}
          </button>
        </div>
      )}

      {node.isOnline && status?.lastCheckedAtMs != null && (
        <p className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
          <HardDriveDownload className="h-3 w-3" />
          {t('serverManagement.lastChecked', 'Last checked: {{when}}', {
            when: new Date(status.lastCheckedAtMs).toLocaleString(),
          })}
        </p>
      )}
    </div>
  )
}
