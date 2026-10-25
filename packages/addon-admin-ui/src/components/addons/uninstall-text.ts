import type { PackageInstallation, UninstallPackageResult } from '@camstack/types'

/**
 * Text for the uninstall confirm and result dialogs. Pure, so the wording the
 * operator reads before a cluster-wide removal is pinned by a test.
 */

/** The nodes holding `packageName`, hub first — what "everywhere" will touch. */
export function holdersOf(
  installations: readonly PackageInstallation[],
  packageName: string,
): readonly PackageInstallation[] {
  return installations
    .filter((row) => row.packageName === packageName)
    .slice()
    .sort((a, b) => (a.isHub === b.isHub ? a.nodeName.localeCompare(b.nodeName) : a.isHub ? -1 : 1))
}

function holderLine(row: PackageInstallation): string {
  const version = row.version !== null ? ` ${row.version}` : ''
  const state = row.isOnline ? '' : ' (offline: removed when it reconnects)'
  return `- ${row.nodeName}${version}${state}`
}

export function everywhereConfirmMessage(
  displayName: string,
  holders: readonly PackageInstallation[],
  unreachable: readonly string[],
): string {
  const lines = [
    `${displayName} will be uninstalled from ${holders.length} node(s). Its runners stop, its capabilities are deregistered and its code is deleted:`,
    ...holders.map(holderLine),
  ]
  if (unreachable.length > 0) {
    lines.push(`Could not ask: ${unreachable.join(', ')} — not included.`)
  }
  lines.push('This cannot be undone.')
  return lines.join('\n')
}

export function nodeConfirmMessage(
  displayName: string,
  nodeName: string,
  otherHolders: readonly PackageInstallation[],
): string {
  const lines = [
    `${displayName} will be uninstalled from ${nodeName}: its runners stop and its code is deleted.`,
  ]
  if (otherHolders.length > 0) {
    lines.push(
      `It stays installed on: ${otherHolders.map((h) => h.nodeName).join(', ')}. Use "Everywhere" to remove it from every node.`,
    )
  }
  lines.push('This cannot be undone.')
  return lines.join('\n')
}

const OUTCOME_LABEL: Readonly<
  Record<UninstallPackageResult['results'][number]['outcome'], string>
> = {
  uninstalled: 'uninstalled',
  'not-installed': 'was not installed',
  refused: 'REFUSED',
  failed: 'FAILED',
  'pending-reconnect': 'offline — removed when it reconnects',
}

/** One line per node, then its error and warnings indented under it. */
export function resultMessage(
  result: UninstallPackageResult,
  nodeName: (nodeId: string) => string,
): string {
  const lines: string[] = []
  for (const row of result.results) {
    const runners =
      row.runnersStopped.length > 0 ? ` (stopped ${row.runnersStopped.join(', ')})` : ''
    lines.push(`${nodeName(row.nodeId)}: ${OUTCOME_LABEL[row.outcome]}${runners}`)
    if (row.error !== undefined) lines.push(`  ${row.error}`)
    for (const warning of row.warnings) lines.push(`  ${warning}`)
  }
  return lines.join('\n')
}
