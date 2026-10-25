import { ArrowRight, RotateCcw, Zap } from 'lucide-react'
import type { AddonUpdateEntry } from '@camstack/types'
import { useTranslation } from 'react-i18next'

export type UpdateEntry = AddonUpdateEntry

// ---------------------------------------------------------------------------
// UpdatesList
// ---------------------------------------------------------------------------

interface UpdatesListProps {
  updates: readonly UpdateEntry[]
  onUpdate: (name: string) => void
  onUpdateAll: () => void
  onCheckUpdates: () => void
  isChecking: boolean
}

export function UpdatesList({
  updates,
  onUpdate,
  onUpdateAll,
  onCheckUpdates,
  isChecking,
}: UpdatesListProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onCheckUpdates}
          disabled={isChecking}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-surface transition-colors disabled:opacity-50"
        >
          <RotateCcw className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`} />
          {isChecking
            ? t('addons.updatesList.checking', 'Checking…')
            : t('addons.updatesList.checkForUpdates', 'Check for updates')}
        </button>

        {updates.length > 0 && (
          <button
            type="button"
            onClick={onUpdateAll}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('addons.updatesList.updateAll', { count: updates.length })}
          </button>
        )}
      </div>

      {updates.length === 0 && !isChecking && (
        <div className="rounded-lg border border-border bg-surface py-10 text-center text-xs text-foreground-subtle">
          {t('addons.updatesList.allPackagesAreUpTo', 'All packages are up to date')}
        </div>
      )}

      {updates.length > 0 && (
        <div className="space-y-2">
          {updates.map((update) => (
            <div
              key={update.name}
              className="rounded-lg border border-border bg-surface px-4 py-3 flex items-start justify-between gap-4"
            >
              <div className="flex items-start gap-3 min-w-0">
                {/* Icon letter */}
                <div className="flex-shrink-0 h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <span className="text-xs font-bold text-primary uppercase">
                    {update.name.charAt(0)}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{update.name}</span>
                    {update.requiresRestart ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning px-2 py-0.5 text-[10px] font-medium">
                        <RotateCcw className="h-2.5 w-2.5" />
                        {t('addons.updatesList.restart', 'Restart')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 text-green-400 px-2 py-0.5 text-[10px] font-medium">
                        <Zap className="h-2.5 w-2.5" />
                        {t('addons.updatesList.hotSwap', 'Hot-swap')}
                      </span>
                    )}
                  </div>

                  {/* Version diff */}
                  <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                    <span className="text-foreground-subtle font-mono">
                      v{update.currentVersion}
                    </span>
                    <ArrowRight className="h-3 w-3 text-foreground-subtle" />
                    <span className="text-green-400 font-mono font-medium">
                      v{update.latestVersion}
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onUpdate(update.name)}
                className="flex-shrink-0 rounded-md bg-primary/10 text-primary hover:bg-primary/20 px-3 py-1.5 text-xs font-medium transition-colors"
              >
                {t('addons.updatesList.update', 'Update')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
