import type { BulkUpdateItem } from '@camstack/types'
import { addonProcessProblem } from '../../lib/addon-process-problem.js'
import {
  Button,
  DeviceExportPanel,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EventStream,
  LogStream,
  useAddonsGetAddonAutoUpdate,
  useAddonsInstallPackage,
  useAddonsRestartAddon,
  useAddonsRetryLoad,
  useAddonsSetAddonAutoUpdate,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertOctagon,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Package,
  Puzzle,
  RefreshCw,
  ScrollText,
  Settings,
  Upload,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { hubPath } from '../../lib/mount'
import { NodeAddonsSettingsPanel } from '../settings/NodeAddonsSettingsPanel'
import { AddonRowBadge } from './AddonRowBadge'
import type { AddonTaskProgress } from './AddonsJobProgress'
import { AddonsJobProgress } from './AddonsJobProgress'
import { AddonUninstallControls, type UninstallTargetNode } from './AddonUninstallControls'
import { VersionPicker } from './VersionPicker'
import { useTranslation } from 'react-i18next'

/** Cap name marking an addon as a `device-export` provider. */
const DEVICE_EXPORT_CAP_NAME = 'device-export'

/** True when the addon's manifest declares the `device-export` capability. */
function declaresDeviceExport(manifest: AddonManifest): boolean {
  return manifest.capabilities.some(
    (cap) => (typeof cap === 'string' ? cap : cap.name) === DEVICE_EXPORT_CAP_NAME,
  )
}

/** Registry install when not explicitly local or upload (absent ⇒ npm). */
function isRegistryInstallSource(installSource?: 'npm' | 'local' | 'upload'): boolean {
  return installSource !== 'local' && installSource !== 'upload'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddonManifest {
  id: string
  name: string
  version: string
  description?: string
  capabilities: readonly (string | { name: string; mode?: string })[]
  requiredFeatures?: readonly string[]
  removable?: boolean
  protected?: boolean
  components?: string[]
  packageName: string
  packageVersion: string
  packageDisplayName?: string
  /** Path to a bundled SVG icon, relative to the addon dir (e.g. `assets/icon.svg`). */
  icon?: string
  /** Tint colour used as the icon-tile background (hex, with or without #). */
  color?: string
  /** Bundle metadata when the npm package ships multiple entries. */
  bundle?: { displayName: string; description?: string; icon?: string }
}

export interface AddonHealth {
  phase: 'pending' | 'healthy' | 'failed'
  retryCount: number
  firstFailureAt: number | null
  lastAttemptAt: number | null
  lastError: { message: string; stack?: string } | null
  nextRetryAt: number | null
  alertEmitted: boolean
  retrying: boolean
  inGracePeriod: boolean
}

/** Where an addon may be deployed. Mirrors `AddonPlacement` in @camstack/types. */
export type AddonPlacement = 'hub-only' | 'agent-only' | 'any-node'

export interface AddonListItem {
  manifest: AddonManifest
  enabled: boolean
  source?: 'core' | 'installed'
  installSource?: 'npm' | 'local' | 'upload'
  installedOn?: string[]
  process?: { pid?: number; mode: 'forked' | 'in-process'; state: string; reason?: string }
  /** True when a pre-update backup is on disk and rollback is possible. */
  hasBackup?: boolean
  /** Kernel health snapshot from AddonHealthMonitor. Null when monitor doesn't track this package. */
  health?: AddonHealth | null
  /**
   * Effective execution placement, lifted from the addon's
   * `declaration.execution.placement`. Drives the node-compatibility
   * filter on the Addons page. Undefined ⇒ treated as `hub-only`.
   */
  placement?: AddonPlacement
}

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

/**
 * Try the addon's bundled SVG (`/api/addon-assets/<addonId>/<icon>`) first
 * — that's what `addon-provider-{reolink,hikvision,rtsp,onvif,…}`
 * already ship via `package.json -> camstack.addons[].icon`. Fall back to
 * a lucide glyph (Package for bundles, Puzzle for singles) when the asset
 * 404s, which keeps every addon row rendering even before icons are
 * authored for the new packages.
 */
function AddonIcon({
  isBundle,
  installSource,
  addonId,
  iconPath,
  color,
}: {
  isBundle?: boolean
  installSource?: 'npm' | 'local' | 'upload'
  addonId?: string
  iconPath?: string
  color?: string
}) {
  const [iconBroken, setIconBroken] = useState(false)
  const tileBg = color
    ? { backgroundColor: `${color.startsWith('#') ? color : `#${color}`}26` /* ~15% opacity */ }
    : undefined
  const fallbackTile = isBundle
    ? 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-300'
    : 'bg-purple-500/20 text-purple-700 dark:text-purple-300'
  const assetUrl = addonId && iconPath ? hubPath(`/api/addon-assets/${addonId}/${iconPath}`) : null
  const showAsset = !!assetUrl && !iconBroken
  return (
    <div className="relative flex-shrink-0">
      <div
        className={`h-8 w-8 rounded-md flex items-center justify-center ${tileBg ? '' : fallbackTile}`}
        style={tileBg}
      >
        {showAsset ? (
          <img
            src={assetUrl!}
            alt={addonId}
            className="h-4 w-4"
            onError={() => setIconBroken(true)}
          />
        ) : isBundle ? (
          <Package className="h-3.5 w-3.5" />
        ) : (
          <Puzzle className="h-3.5 w-3.5" />
        )}
      </div>
      {installSource === 'local' && (
        <span className="absolute -top-1.5 -left-1.5 text-[7px] font-bold leading-none bg-orange-500 text-white px-1 py-0.5 rounded -rotate-12 shadow-sm">
          DEV
        </span>
      )}
      {isRegistryInstallSource(installSource) && (
        <span className="absolute -top-1 -left-1 w-4 h-4 rounded bg-[#cb3837] flex items-center justify-center -rotate-12 shadow-sm">
          <svg viewBox="0 0 780 250" className="w-[11px] h-[11px]">
            <path fill="#fff" d="M240 250h100V50h100v200h340V0H0v250z" />
          </svg>
        </span>
      )}
      {installSource === 'upload' && (
        <span className="absolute -top-1.5 -left-1.5 flex items-center justify-center h-4 w-4 rounded bg-cyan-500 -rotate-12 shadow-sm">
          <Upload className="h-2.5 w-2.5 text-white" />
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// VersionPill — version affordance next to the addon name
//
// No update available: a quiet pill showing the current version; tapping it
// opens the version picker (install any version explicitly).
//
// Update available: the standard version SELECTOR (dropdown of available
// versions, glowing amber, default = latest available, current version kept
// visible) with an "Update" button immediately to its LEFT that installs
// the SELECTED version.
// ---------------------------------------------------------------------------

interface VersionPillProps {
  readonly version: string
  readonly availableUpdate?: string
  /** Version the Update button will install (defaults to latest available). */
  readonly selectedVersion?: string
  readonly isUpdating?: boolean
  readonly installSource?: 'npm' | 'local' | 'upload'
  readonly disabled?: boolean
  readonly onUpdate?: () => void
  readonly onOpenPicker: () => void
  readonly children?: ReactNode
}

function VersionPill({
  version,
  availableUpdate,
  selectedVersion,
  isUpdating,
  installSource,
  disabled,
  onUpdate,
  onOpenPicker,
  children,
}: VersionPillProps) {
  const { t } = useTranslation()
  if (isUpdating) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('addons.addonCard.updating', 'Updating…')}
      </span>
    )
  }

  if (availableUpdate) {
    const target = selectedVersion ?? availableUpdate
    return (
      <div className="relative inline-flex items-center gap-1 shrink-0">
        {/* Update CTA — immediately LEFT of the version selector. */}
        {onUpdate && (
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onUpdate()
            }}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title={t('addons.addonCard.updateTo', 'Update to {{target}}', { target })}
          >
            <Download className="h-3 w-3" />
            {t('addons.addonCard.update', 'Update')}
          </Button>
        )}
        {/* Version selector — glows while an update is available. Shows the
            current installed version and the selected target. */}
        <Button
          variant="unstyled"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenPicker()
          }}
          disabled={disabled}
          aria-label={t('addons.addonCard.selectVersionToInstall', 'Select version to install')}
          title={t(
            'addons.addonCard.installedUpdateAvailableSelectedTap',
            'Installed {{version}} — update available. Selected {{target}}; tap to choose another version.',
            { version, target },
          )}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono border border-amber-500/40 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 animate-pulse disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span className="font-normal opacity-70">{version}</span>
          <span className="font-normal opacity-70">→</span>
          {target}
          <ChevronDown className="h-3 w-3" />
        </Button>
        {children}
      </div>
    )
  }

  const tone =
    installSource === 'local'
      ? 'border-orange-500/30 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'

  return (
    <div className="relative inline-flex items-center gap-1 shrink-0">
      <Button
        variant="unstyled"
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenPicker()
        }}
        disabled={disabled}
        className={[
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold font-mono border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
          tone,
        ].join(' ')}
        title={t(
          'addons.addonCard.versionTapToViewAll',
          'Version {{version}} — tap to view all versions',
          { version },
        )}
      >
        {version}
        <ChevronDown className="h-3 w-3 opacity-50" />
      </Button>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bundle group type (used when multiple addons share a package)
// ---------------------------------------------------------------------------

export interface BundleGroup {
  packageName: string
  displayName: string
  version: string
  installSource?: 'npm' | 'local' | 'upload'
  /**
   * Optional metadata from the package manifest's `camstack.bundle` field
   * (Phase C of bundles refactor). When present, the bundle card uses
   * `bundle.displayName` as its header and renders the description in
   * the expanded body. Single-entry packages and multi-entry packages
   * without `bundle` declared in their manifest fall back to deriving
   * `displayName` from `packageDisplayName` / first addon name.
   */
  bundle?: { displayName: string; description?: string; icon?: string }
  addons: AddonListItem[]
}

// ---------------------------------------------------------------------------
// AutoUpdateSelector — per-addon auto-update override
// ---------------------------------------------------------------------------

function AutoUpdateSelector({ addonId }: { addonId: string }) {
  const queryClient = useQueryClient()

  const { data: channel = 'inherit' } = useAddonsGetAddonAutoUpdate({ addonId })

  const mutation = useAddonsSetAddonAutoUpdate({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons', 'getAddonAutoUpdate']] })
    },
  })

  return (
    <div className="flex rounded-lg border border-border overflow-hidden text-[10px] font-medium">
      {(['inherit', 'off', 'latest', 'beta'] as const).map((ch) => (
        <Button
          variant="unstyled"
          key={ch}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            mutation.mutate({ addonId, channel: ch })
          }}
          disabled={mutation.isPending}
          className={`px-2.5 py-1 transition-colors capitalize ${
            channel === ch
              ? ch === 'inherit'
                ? 'bg-gray-700/50 text-gray-700 dark:text-gray-300'
                : ch === 'off'
                  ? 'bg-gray-700 text-gray-700 dark:text-gray-300'
                  : ch === 'latest'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-amber-500/20 text-amber-400'
              : 'bg-transparent text-foreground-subtle hover:bg-surface-hover'
          } ${ch !== 'inherit' ? 'border-l border-border' : ''}`}
        >
          {ch}
        </Button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AddonCard — single addon OR bundle group header
// ---------------------------------------------------------------------------

export interface ClusterNodeStatus {
  nodeId: string
  name: string
  version: string
  status: string
  synced: boolean
}

export interface ClusterAddonStatus {
  hubVersion: string
  nodes: readonly ClusterNodeStatus[]
}

interface AddonCardProps {
  addon: AddonListItem
  /** Cluster deployment status for this addon (multi-node) */
  clusterStatus?: ClusterAddonStatus
  /** Hide version when addon is nested inside a bundle */
  hideVersion?: boolean
  /** Latest available version from npm (if update available) */
  availableUpdate?: string
  /** Callback when user clicks the update button — receives the SELECTED version */
  onUpdate?: (version: string) => void
  /** Whether an update is in progress for this addon */
  isUpdating?: boolean
  /** Live lifecycle-job progress for this addon's package (F4) */
  readonly jobProgress?: AddonTaskProgress | null
  /** When set, this card renders as a bundle group header wrapping multiple addons */
  bundle?: BundleGroup
  /** Bulk-update item for this addon — renders AddonRowBadge when present */
  readonly bulkItem?: BulkUpdateItem | null
  /** When true, all action buttons are disabled (bulk update in progress) */
  readonly disabledByBulk?: boolean
  /**
   * True when this card represents the `@camstack/system` framework
   * package. Renders a "System" badge and signals to the parent that
   * updating it restarts the hub (the parent gates the update behind a
   * confirmation modal).
   */
  readonly isSystem?: boolean
  /** The node the Addons page is scoped to — where "Uninstall" acts. Defaults to the hub. */
  readonly selectedNode?: UninstallTargetNode
}

/** The node "Uninstall" targets when the page names none. */
const HUB_NODE: UninstallTargetNode = { id: 'hub', name: 'Hub', isHub: true }

export function AddonCard({
  addon,
  clusterStatus,
  hideVersion,
  availableUpdate,
  onUpdate,
  isUpdating,
  jobProgress,
  bundle,
  bulkItem,
  disabledByBulk,
  isSystem,
  selectedNode,
}: AddonCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [showVersionPicker, setShowVersionPicker] = useState(false)
  // Version the Update button installs. `null` = "latest available" —
  // reset whenever the available update changes (new release published,
  // or the update was applied and the affordance disappears).
  const [selectedUpdateVersion, setSelectedUpdateVersion] = useState<string | null>(null)
  useEffect(() => {
    setSelectedUpdateVersion(null)
  }, [availableUpdate])
  const updateTarget = selectedUpdateVersion ?? availableUpdate
  const [showLogs, setShowLogs] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [consoleTab, setConsoleTab] = useState<'logs' | 'events'>('logs')
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { manifest } = addon
  const removable = !bundle && !manifest.protected && manifest.removable !== false
  const isBundle = !!bundle

  // Display values — bundle overrides
  const displayName = bundle?.displayName ?? manifest.name
  const displayPkgName = bundle?.packageName ?? manifest.packageName
  const displayVersion = bundle?.version ?? manifest.packageVersion ?? manifest.version
  const displayInstallSource = bundle?.installSource ?? addon.installSource
  // Prefer the manifest's `camstack.bundle.description` (operator-curated)
  // over the first child addon's individual description for bundles.
  const displayDescription = bundle
    ? (bundle.bundle?.description ?? bundle.addons[0]?.manifest.description)
    : manifest.description

  // Settings-redesign cleanup: the inline Settings dialog now delegates
  // to `NodeAddonsSettingsPanel` at `level: 'global'` targeting this
  // single addon. The legacy `addons.getConfigSchema / getConfig /
  // updateConfig` tRPC endpoints were deleted; schema/values/save
  // all flow through the three-level API inside the panel.

  const restartMutation = useAddonsRestartAddon({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons']] })
    },
  })

  const installVersionMutation = useAddonsInstallPackage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons']] })
      queryClient.invalidateQueries({ queryKey: [['addonPages']] })
      queryClient.invalidateQueries({ queryKey: [['capabilities']] })
      queryClient.invalidateQueries({ queryKey: [['integrations']] })
    },
  })

  // Manual retry for the kernel-level health monitor. Resets the
  // retry counter (next failure starts from 60s again). Idempotent
  // on healthy addons. Bundles share the package so the call uses
  // the package name from manifest, not the addon id.
  const retryLoadMutation = useAddonsRetryLoad({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons']] })
      queryClient.invalidateQueries({ queryKey: [['alerts']] })
    },
  })

  // Health visibility: only surface in UI AFTER grace ends. During
  // grace the row stays neutral — the operator might be watching
  // boot and a transient "still loading" addon shouldn't alarm.
  const health = addon.health
  const showHealthFailure = health?.phase === 'failed' && !health.inGracePeriod
  const showRetryCountdown = showHealthFailure && health?.nextRetryAt && !health.retrying
  const processProblem = addonProcessProblem(addon.process)

  return (
    <div
      className={`rounded-md border bg-surface overflow-hidden ${
        showHealthFailure ? 'border-red-500/50' : 'border-border'
      }`}
    >
      {/* Health-failure banner — kernel monitor reports load/init
          failure post-grace. Shows the error message + a Retry button
          that resets the retry counter and forces an immediate reload. */}
      {showHealthFailure && health && (
        <div className="bg-danger/10 border-b border-danger/30 px-3 py-2 flex items-start gap-2">
          <AlertOctagon className="h-4 w-4 text-danger shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-danger">
              {t('addons.addonCard.failedToLoad', { attempt: health.retryCount })}
            </div>
            <div className="text-[11px] text-foreground mt-0.5 break-words font-mono">
              {health.lastError?.message ?? t('addons.addonCard.unknownError', 'Unknown error')}
            </div>
            {showRetryCountdown && health.nextRetryAt && (
              <div className="text-[10px] text-foreground-subtle mt-1">
                {t('addons.addonCard.autoRetryAt', {
                  time: new Date(health.nextRetryAt).toLocaleTimeString(),
                })}
              </div>
            )}
          </div>
          <Button
            variant="unstyled"
            type="button"
            disabled={retryLoadMutation.isPending || health.retrying}
            onClick={(e) => {
              e.stopPropagation()
              retryLoadMutation.mutate({ packageName: displayPkgName })
            }}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold border border-red-400/40 bg-red-400/10 text-red-700 dark:text-red-300 hover:bg-red-400/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            title={t(
              'addons.addonCard.resetRetryCounterAndForce',
              'Reset retry counter and force immediate reload',
            )}
          >
            <RefreshCw
              className={`h-3 w-3 ${retryLoadMutation.isPending || health.retrying ? 'animate-spin' : ''}`}
            />
            {t('addons.addonCard.retryNow', 'Retry now')}
          </Button>
        </div>
      )}
      {/* Runner problem — the addon's runner is failed / refused / missing
          (the truthful process state, D877). A refusal carries its own remedy;
          Restart in the toolbar below retries it. */}
      {processProblem !== null && (
        <div className="bg-danger/10 border-b border-danger/30 px-3 py-2 flex items-start gap-2">
          <AlertOctagon className="h-4 w-4 text-danger shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-danger">
              {t(`addons.addonCard.processProblem.${processProblem.kind}`)}
            </div>
            {processProblem.reason !== undefined && (
              <div className="text-[11px] text-foreground mt-0.5 break-words font-mono">
                {processProblem.reason}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Header — icon + (name / pkg+badges / description / process) + version.
          Layout stacks cleanly on mobile: the name owns row 1 and is never
          crowded out by the package name or badges (which moved to row 2), and
          the version collapses to a single pill. */}
      <div className="flex items-start gap-2.5 px-3 py-2">
        <AddonIcon
          isBundle={isBundle || (!!manifest.components && manifest.components.length > 1)}
          installSource={displayInstallSource}
          addonId={isBundle ? bundle.addons[0]?.manifest.id : manifest.id}
          iconPath={
            isBundle ? (bundle.bundle?.icon ?? bundle.addons[0]?.manifest.icon) : manifest.icon
          }
          color={isBundle ? bundle.addons[0]?.manifest.color : manifest.color}
        />

        <div className="flex-1 min-w-0">
          {/* Row 1: name (priority) + version pill (right). */}
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-semibold text-foreground truncate min-w-0">
              {displayName}
            </span>
            {!hideVersion && (
              <VersionPill
                version={displayVersion}
                availableUpdate={availableUpdate}
                {...(updateTarget !== undefined ? { selectedVersion: updateTarget } : {})}
                isUpdating={isUpdating}
                installSource={displayInstallSource}
                disabled={disabledByBulk}
                {...(onUpdate && updateTarget !== undefined
                  ? { onUpdate: () => onUpdate(updateTarget) }
                  : {})}
                onOpenPicker={() => setShowVersionPicker((v) => !v)}
              >
                {showVersionPicker && (
                  <VersionPicker
                    packageName={displayPkgName}
                    currentVersion={displayVersion}
                    {...(displayInstallSource ? { installSource: displayInstallSource } : {})}
                    {...(availableUpdate !== undefined && updateTarget !== undefined
                      ? {
                          // Update flow: rows SELECT the target version; the
                          // adjacent Update button performs the install.
                          selectedVersion: updateTarget,
                          onSelect: (version: string) => {
                            setSelectedUpdateVersion(version)
                            setShowVersionPicker(false)
                          },
                        }
                      : {})}
                    onInstall={(version) => {
                      setShowVersionPicker(false)
                      installVersionMutation.mutate({ packageName: displayPkgName, version })
                    }}
                    onClose={() => setShowVersionPicker(false)}
                  />
                )}
              </VersionPill>
            )}
          </div>

          {/* Row 2: package name + bundle/system/bulk badges — secondary,
              wraps, never steals the name's space. The package name is shown
              only when it adds information (i.e. differs from the display
              name) to avoid redundant "@camstack/x (@camstack/x)" noise. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-0.5">
            {displayPkgName !== displayName && (
              <span className="text-[10px] text-foreground-subtle font-mono truncate max-w-full">
                {displayPkgName}
              </span>
            )}
            {isBundle && (
              <span className="text-[10px] rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium shrink-0 inline-flex items-center gap-1">
                <Package className="h-3 w-3" />
                {bundle.addons.length}
              </span>
            )}
            {isSystem && (
              <span
                className="text-[10px] rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 font-medium shrink-0 inline-flex items-center gap-1"
                title={t(
                  'addons.addonCard.systemPackageUpdatingRestartsThe',
                  'System package — updating restarts the hub',
                )}
              >
                <RefreshCw className="h-3 w-3" />
                {t('addons.addonCard.system', 'System')}
              </span>
            )}
            {bulkItem != null && <AddonRowBadge item={bulkItem} />}
            {/* F4: live per-addon lifecycle-job progress — keyed per job on
                the page, so concurrent updates render independently. */}
            {jobProgress != null && <AddonsJobProgress progress={jobProgress} />}
          </div>

          {displayDescription && (
            <p className="text-[10px] text-foreground-subtle mt-1 line-clamp-1">
              {displayDescription}
            </p>
          )}
          {/* Process info badges */}
          {!isBundle && addon.process && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span
                className={`text-[9px] rounded-full px-1.5 py-0.5 font-medium ${
                  addon.process.mode === 'forked'
                    ? 'bg-blue-500/15 text-blue-400'
                    : 'bg-gray-500/15 text-gray-400'
                }`}
              >
                {addon.process.mode === 'forked'
                  ? t('addons.addonCard.forked')
                  : t('addons.addonCard.inProcess')}
              </span>
              {addon.process.pid != null && (
                <span className="text-[9px] font-mono text-foreground-subtle">
                  PID {addon.process.pid}
                </span>
              )}
              <span
                className={`text-[9px] rounded-full px-1.5 py-0.5 font-medium ${
                  addon.process.state === 'running'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : processProblem !== null
                      ? 'bg-red-500/15 text-red-400'
                      : 'bg-gray-500/15 text-gray-400'
                }`}
              >
                {addon.process.state}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Toolbar — every non-bundle row gets actions, including child
          cards rendered inside a bundle group (they're real addons,
          just visually nested). The previous gate also keyed off
          `hideVersion` which is set for bundle children to dedupe the
          version badge — that flag is purely a layout signal, not a
          permission to drop actions. */}
      {!isBundle && (
        <div className="flex items-center gap-1 px-3 py-1 border-t border-border/50 bg-surface-hover/20">
          {/* Restart — no confirm */}
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              restartMutation.mutate({ addonId: manifest.id })
            }}
            disabled={restartMutation.isPending || disabledByBulk}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border border-border text-foreground-subtle hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/10 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${restartMutation.isPending ? 'animate-spin' : ''}`} />
            {t('addons.addonCard.restart', 'Restart')}
          </Button>

          {/* Logs toggle */}
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setShowLogs((v) => !v)
            }}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
              showLogs
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border text-foreground-subtle hover:text-foreground hover:border-primary/30 hover:bg-primary/10'
            }`}
          >
            <ScrollText className="h-3 w-3" />
            {t('addons.addonCard.logs', 'Logs')}
          </Button>

          {/* Update + Rollback moved out of the toolbar:
              - Update CTA now sits next to the version chip in the
                header, where the version-picker lives. The amber
                chip + adjacent Update button are co-located so the
                "you can upgrade" affordance reads as one unit.
              - Rollback removed entirely. Operators downgrade by
                opening the version picker (chevron next to the
                version chip) and selecting the previous version
                explicitly — the same code path with a clearer
                mental model. The hidden ".pre-update-backup"
                folder is still on disk for any future restore
                tooling. */}

          {/* Settings cog — opens dialog. Always shown for single
              addons; the dialog's NodeAddonsSettingsPanel renders a
              placeholder when the addon exposes no global settings. */}
          {!isBundle && (
            <Button
              variant="unstyled"
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setShowSettings(true)
              }}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border transition-colors ${
                showSettings
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-foreground-subtle hover:text-foreground hover:border-primary/30 hover:bg-primary/10'
              }`}
            >
              <Settings className="h-3 w-3" />
              {t('addons.addonCard.settings', 'Settings')}
            </Button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Uninstall — right side. Per node (the page's selected node) and
              everywhere; the controls own the confirm and the per-node report. */}
          {removable && (
            <AddonUninstallControls
              packageName={manifest.packageName}
              displayName={manifest.name}
              selectedNode={selectedNode ?? HUB_NODE}
              disabled={disabledByBulk}
            />
          )}
        </div>
      )}

      {/* Cluster deployment info — shown when multi-node */}
      {clusterStatus && clusterStatus.nodes.length > 1 && !isBundle && (
        <div className="border-t border-border px-3 py-1.5 bg-muted/10">
          <div className="text-[10px] font-medium text-foreground-subtle mb-1.5">
            {t('addons.addonCard.clusterDeployment', 'Cluster Deployment')}
          </div>
          <div className="space-y-1">
            {clusterStatus.nodes.map((node) => (
              <div key={node.nodeId} className="flex items-center gap-2 text-[10px]">
                <div
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    node.status === 'offline'
                      ? 'bg-muted-foreground/30'
                      : node.synced
                        ? 'bg-success'
                        : 'bg-amber-500'
                  }`}
                />
                <span className="font-medium text-foreground min-w-[60px]">{node.name}</span>
                <span className="font-mono text-foreground-subtle">{node.version}</span>
                {!node.synced && node.status !== 'offline' && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {t('addons.addonCard.outdated')}
                  </span>
                )}
                {node.status === 'offline' && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                    {t('common.offline')}
                  </span>
                )}
                {node.synced && node.status !== 'offline' && (
                  <span className="text-[9px] text-success">{t('common.synced')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Console panel (Logs / Events tabs) */}
      {showLogs && !isBundle && (
        <div className="border-t border-border">
          <div className="flex items-center px-3 py-0.5 bg-surface-hover/20 border-b border-border/50">
            <div className="flex rounded border border-border overflow-hidden text-[9px]">
              <Button
                variant="unstyled"
                type="button"
                onClick={() => setConsoleTab('logs')}
                className={`px-2 py-0.5 transition-colors ${
                  consoleTab === 'logs'
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover'
                }`}
              >
                {t('addons.addonCard.logs', 'Logs')}
              </Button>
              <Button
                variant="unstyled"
                type="button"
                onClick={() => setConsoleTab('events')}
                className={`px-2 py-0.5 border-l border-border transition-colors ${
                  consoleTab === 'events'
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover'
                }`}
              >
                {t('addons.addonCard.events', 'Events')}
              </Button>
            </div>
            <div className="flex-1" />
            <Button
              variant="unstyled"
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setShowLogs(false)
              }}
              className="text-foreground-subtle hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {consoleTab === 'logs' && (
            <LogStream addonId={manifest.id} maxHeight="max-h-64" showFilters={false} />
          )}
          {consoleTab === 'events' && (
            <EventStream addonId={manifest.id} category="addon.*" maxHeight="max-h-64" />
          )}
        </div>
      )}

      {/* Bundle: expand tab + child addons */}
      {isBundle && (
        <>
          <Button
            variant="unstyled"
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="w-full flex items-center justify-center border-t border-border py-1 hover:bg-surface-hover/50 transition-colors"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-foreground-subtle" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-foreground-subtle" />
            )}
          </Button>

          {expanded && (
            <div className="border-t border-border px-2.5 py-1.5 space-y-1.5">
              {bundle.addons.map((childAddon) => (
                <AddonCard key={childAddon.manifest.id} addon={childAddon} hideVersion />
              ))}
            </div>
          )}
        </>
      )}

      {/* Settings dialog (modal) */}
      {showSettings && !isBundle && (
        <Dialog open onOpenChange={(next) => !next && setShowSettings(false)}>
          <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-primary" />
                {t('addons.addonCard.settingsTitle', { name: displayName })}
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              {/* Cluster-level settings rendered via the three-level API.
                  Falls back silently to "no editable settings" when the
                  addon doesn't implement `getGlobalSettings`.

                  SCOPE. This dialog is opened from an addon card. There is no
                  node behind it — not the operator's current node, not the
                  node the addon happens to run on. It used to pass a literal
                  `nodeId="hub"`, which was invisible and wrong for the five
                  addons that declare `perNode` fields: `terminal.btmPath`
                  edited here wrote `btmPath@hub` while the same field edited
                  from Cluster → some-agent wrote `btmPath@some-agent`. Two
                  controls, one label, different targets, both showing a
                  value.

                  So the dialog now renders `fieldScope="cluster"` — the
                  fields that genuinely are one value for the whole cluster,
                  which are the only ones it can edit without inventing a
                  node — and passes no node at all. Per-node fields have a
                  node-addressed home already (Cluster → node → Settings,
                  Cluster → Pipeline → node, System → Terminal). */}
              <div className="text-[10px] text-foreground-subtle mb-2">
                {t(
                  'addons.addonCard.clusterWideSettingsOneValue',
                  'Cluster-wide settings — one value for every node. Per-node settings live under Cluster → the node → Settings.',
                )}
              </div>
              <NodeAddonsSettingsPanel
                nodeId={null}
                addonIds={[manifest.id]}
                level="global"
                fieldScope="cluster"
                emptyMessage={t(
                  'addons.addonCard.thisAddonExposesNoCluster',
                  'This addon exposes no cluster-wide settings. Anything it can configure is per-node — open it from Cluster → the node → Settings.',
                )}
              />

              {/* Generic device-export surface — rendered for any addon
                  that declares the `device-export` capability (HomeKit /
                  Alexa / HA-MQTT / future exporters). Replaces the
                  per-addon Module-Federation overview pages: the exposed-
                  devices table + unexpose action are now driven entirely
                  by the cap. */}
              {declaresDeviceExport(manifest) && (
                <div>
                  <div className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-2">
                    {t('addons.addonCard.deviceExport', 'Device export')}
                  </div>
                  <DeviceExportPanel
                    addonId={manifest.id}
                    onOpenDevice={(deviceId) => navigate(`/devices/${deviceId}`)}
                  />
                </div>
              )}

              {/* Auto-update override (only for npm addons) */}
              {isRegistryInstallSource(displayInstallSource) && (
                <div>
                  <div className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-2">
                    {t('addons.addonCard.autoUpdate', 'Auto-Update')}
                  </div>
                  <AutoUpdateSelector addonId={manifest.id} />
                </div>
              )}

              {/* Components list (for core) */}
              {manifest.components && manifest.components.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-2">
                    {t('addons.addonCard.components', { count: manifest.components.length })}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {manifest.components.map((comp) => (
                      <span
                        key={comp}
                        className="text-[10px] rounded bg-background border border-border px-1.5 py-0.5 text-foreground-subtle font-mono"
                      >
                        {comp}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </DialogBody>
            {/* Save lives inside NodeAddonsSettingsPanel — outer dialog only needs Close. */}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(false)}
              >
                {t('common.close', 'Close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
