import { Lock } from 'lucide-react'
import type { BulkUpdateItem } from '@camstack/types'
import { AddonRowBadge } from './AddonRowBadge'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

interface AddonRowAddon {
  readonly name: string
  readonly currentVersion: string
  readonly isSystem: boolean
  readonly status?: string
}

interface AddonRowProps {
  readonly addon: AddonRowAddon
  readonly bulkItem: BulkUpdateItem | null
  readonly disabledByBulk: boolean
  readonly latestVersion: string | null
  readonly onUpdate: (version: string) => void
  readonly onRestart: () => void
  readonly onUninstall: () => void
}

export function AddonRow({
  addon,
  bulkItem,
  disabledByBulk,
  latestVersion,
  onUpdate,
  onRestart,
  onUninstall,
}: AddonRowProps) {
  const { t } = useTranslation()
  const { isSystem } = addon
  const hasUpdate = latestVersion !== null && latestVersion !== addon.currentVersion
  return (
    <tr className={isSystem ? 'bg-amber-500/5' : ''}>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-2">
          {isSystem && (
            <Lock
              className="w-3 h-3 text-amber-700"
              aria-label={t('addons.addonRow.systemPackage', 'System package')}
            />
          )}
          <span className="font-mono text-xs">{addon.name}</span>
          {isSystem && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-800 font-medium">
              SYSTEM
            </span>
          )}
          {isSystem && (
            <span
              className="ml-1 text-[10px] uppercase tracking-wide text-amber-700/80"
              title={t(
                'addons.addonRow.changesRequireAHubRestart',
                'Changes require a hub restart',
              )}
            >
              {t('addons.addonRow.requiresRestart', 'requires restart')}
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <span className="font-mono text-xs">{addon.currentVersion}</span>
      </td>
      <td className="px-2 py-1.5">
        <span className="font-mono text-xs">{latestVersion ?? '—'}</span>
      </td>
      <td className="px-2 py-1.5">{bulkItem !== null && <AddonRowBadge item={bulkItem} />}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          {hasUpdate && (
            <Button
              variant="unstyled"
              type="button"
              disabled={disabledByBulk}
              onClick={() => onUpdate(latestVersion!)}
              className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40"
            >
              {t('addons.addonRow.update', 'Update')}
            </Button>
          )}
          <Button
            variant="unstyled"
            type="button"
            disabled={disabledByBulk}
            onClick={onRestart}
            className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40"
          >
            {t('addons.addonRow.restart', 'Restart')}
          </Button>
          {!isSystem && (
            <Button
              variant="unstyled"
              type="button"
              disabled={disabledByBulk}
              onClick={onUninstall}
              className="text-[10px] px-2 py-0.5 rounded bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-40"
            >
              {t('addons.addonRow.uninstall', 'Uninstall')}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
