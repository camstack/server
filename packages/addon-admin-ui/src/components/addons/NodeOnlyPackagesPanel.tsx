import type { PackageInstallation } from '@camstack/types'
import { useAddonsListInstallations } from '@camstack/ui-library'
import { AlertTriangle } from 'lucide-react'
import {
  AddonUninstallControls,
  ALL_PACKAGES,
  INSTALLATIONS_STALE_MS,
  type UninstallTargetNode,
} from './AddonUninstallControls'
import { useTranslation } from 'react-i18next'

/**
 * Packages a node runs itself and the hub never installs — never stale, never
 * listed here. Framework packages travel inside the server closure.
 */
const SELF_MANAGED_PACKAGES: ReadonlySet<string> = new Set([
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
  '@camstack/ui-library',
  '@camstack/addon-agent-ui',
])

export interface NodeOnlyPackageGroup {
  readonly packageName: string
  readonly rows: readonly PackageInstallation[]
}

/**
 * Agent copies of packages the hub does not install, for the selected node (an
 * agent) or for every agent (the hub view). These are what the hub-driven
 * Addons list cannot show — the card list is the HUB's packages — and exactly
 * what an uninstall on the hub alone used to leave behind (decoder-ffmpeg on
 * both agents, 2026-10-08).
 */
export function groupNodeOnlyPackages(
  installations: readonly PackageInstallation[],
  selectedNode: UninstallTargetNode,
): readonly NodeOnlyPackageGroup[] {
  const groups = new Map<string, PackageInstallation[]>()
  for (const row of installations) {
    if (row.isHub || row.onHub || SELF_MANAGED_PACKAGES.has(row.packageName)) continue
    if (!selectedNode.isHub && row.nodeId !== selectedNode.id) continue
    const rows = groups.get(row.packageName) ?? []
    rows.push(row)
    groups.set(row.packageName, rows)
  }
  return [...groups]
    .map(([packageName, rows]) => ({ packageName, rows }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
}

export function NodeOnlyPackagesPanel({ selectedNode }: { selectedNode: UninstallTargetNode }) {
  const { t } = useTranslation()
  const { data } = useAddonsListInstallations(ALL_PACKAGES, { staleTime: INSTALLATIONS_STALE_MS })
  // Only a query that ANSWERED may say what is (not) there (D315).
  if (data === undefined) return null
  const groups = groupNodeOnlyPackages(data.installations, selectedNode)
  const unreachable = data.unreachable.filter(
    (u) => selectedNode.isHub || u.nodeId === selectedNode.id,
  )
  if (groups.length === 0 && unreachable.length === 0) return null

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        {selectedNode.isHub
          ? t(
              'addons.nodeOnlyPackagesPanel.installedOnAgentsButNot',
              'Installed on agents but not on the hub',
            )
          : t(
              'addons.nodeOnlyPackagesPanel.installedOnButNotOn',
              'Installed on {{name}} but not on the hub',
              { name: selectedNode.name },
            )}
      </div>
      {unreachable.length > 0 && (
        <div className="text-[10px] text-foreground-subtle">
          {t('addons.nodeOnlyPackagesPanel.unreachable', {
            nodes: unreachable.map((u) => u.nodeId).join(', '),
          })}
        </div>
      )}
      {groups.map((group) => (
        <div
          key={group.packageName}
          className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-border bg-surface px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-xs font-mono text-foreground break-all">{group.packageName}</div>
            <div className="text-[10px] text-foreground-subtle">
              {group.rows
                .map(
                  (r) =>
                    `${r.nodeName}${r.version !== null ? ` ${r.version}` : ''}${r.isOnline ? '' : ' (offline)'}`,
                )
                .join(' · ')}
            </div>
          </div>
          <AddonUninstallControls
            packageName={group.packageName}
            displayName={group.packageName}
            selectedNode={selectedNode}
            hideNodeAction={selectedNode.isHub}
          />
        </div>
      ))}
    </div>
  )
}
