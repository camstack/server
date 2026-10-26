import type { AddonSearchResult } from '@camstack/types'
import { Badge, Button, useAddonsSearchAvailable } from '@camstack/ui-library'
import { Check, Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** One npm package offered for install: the dropdown and the capability group share it. */
export function NpmAddonRow({
  addon,
  installing,
  onInstall,
}: {
  readonly addon: AddonSearchResult
  readonly installing: boolean
  readonly onInstall: (addon: AddonSearchResult) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-surface-hover transition-colors">
      <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center text-primary text-[9px] font-bold shrink-0">
        {addon.name.replace('@camstack/addon-', '').charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          {/* Friendly name first — the scope/prefix truncated everything
              readable on narrow screens. */}
          <span className="text-[11px] font-semibold break-words">
            {addon.name.replace(/^@camstack\/(addon-)?/, '')}
          </span>
          <span className="text-[10px] text-foreground-subtle shrink-0">v{addon.version}</span>
        </div>
        <div className="font-mono text-[9px] text-foreground-subtle/80 truncate">{addon.name}</div>
        {addon.description && (
          <div className="text-[10px] text-foreground-subtle truncate">{addon.description}</div>
        )}
      </div>
      {addon.installed ? (
        <Badge variant="success" icon={<Check className="h-3 w-3" />}>
          {addon.installedVersion ?? t('system.capabilityCatalog.installed', 'Installed')}
        </Badge>
      ) : (
        <Button
          size="sm"
          onClick={() => onInstall(addon)}
          disabled={installing}
          className="shrink-0"
        >
          {installing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          {t('system.capabilityCatalog.install', 'Install')}
        </Button>
      )}
    </div>
  )
}

/**
 * "Available to install" for a `?capability=` link: the npm packages whose
 * manifest declares the capability and that are not installed yet. Three
 * distinct states — asking, failed, answered — because "not heard back yet"
 * must never read as "nothing exists" (D315).
 */
export function AvailableToInstall({
  capability,
  installing,
  onInstall,
}: {
  readonly capability: string
  readonly installing: boolean
  readonly onInstall: (addon: AddonSearchResult) => void
}) {
  const { t } = useTranslation()
  const { data, isPending, isError } = useAddonsSearchAvailable({ capability })

  let body: React.ReactNode
  if (isError) {
    body = (
      <div className="px-3 py-2 text-xs text-danger">
        {t(
          'system.capabilityCatalog.couldNotSearchTheNpm',
          'Could not search the npm catalog right now. Try again in a moment.',
        )}
      </div>
    )
  } else if (isPending || data === undefined) {
    body = (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-foreground-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('system.capabilityCatalog.searchingTheNpmCatalog', 'Searching the npm catalog…')}
      </div>
    )
  } else {
    const installable = data.filter((addon) => !addon.installed)
    body =
      installable.length === 0 ? (
        <div className="px-3 py-2 text-xs text-foreground-subtle">
          {data.length === 0
            ? t(
                'system.capabilityCatalog.noPublishedAddonDeclaresThe',
                'No published addon declares the "{{capability}}" capability.',
                { capability },
              )
            : t(
                'system.capabilityCatalog.everyPublishedAddonThatDeclares',
                'Every published addon that declares "{{capability}}" is already installed.',
                { capability },
              )}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {installable.map((addon) => (
            <NpmAddonRow
              key={addon.name}
              addon={addon}
              installing={installing}
              onInstall={onInstall}
            />
          ))}
        </div>
      )
  }

  return (
    <section
      className="rounded-md border border-border bg-surface overflow-hidden"
      aria-label={t('system.capabilityCatalog.availableToInstall', 'Available to install')}
    >
      <h2 className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle border-b border-border">
        {t('system.capabilityCatalog.availableToInstall', 'Available to install')}
      </h2>
      {body}
    </section>
  )
}
