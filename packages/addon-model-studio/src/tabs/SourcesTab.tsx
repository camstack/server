/**
 * Sources — third-party catalogs (plus catalog + plugin catalog) with Catalog-style cards.
 * Operator-supplied upload/URL lives under Custom.
 */
import { useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import { PlusCatalogSection, type UploadPrefill } from './PlusCatalogSourceSections.js'
import { PluginCatalogTab } from './PluginCatalogTab.js'
import { Trans, useT } from '../i18n/index.js'
import { Button } from '@camstack/ui-library'

interface SourcesTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly onRegistered: () => void
  readonly onPrefillUpload: (prefill: UploadPrefill) => void
}

type SourceKind = 'frigate' | 'scrypted'

export function SourcesTab({ trpc, onRegistered, onPrefillUpload }: SourcesTabProps) {
  const { t } = useT()
  const [kind, setKind] = useState<SourceKind>('frigate')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  return (
    <div className="space-y-4" data-testid="sources-tab">
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle">
        <Trans i18nKey="sources.intro" components={{ mono: <span className="font-mono" /> }} />
      </div>

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {success}
        </div>
      )}

      <div className="inline-flex rounded-md border border-border overflow-hidden">
        {(
          [
            { value: 'frigate', label: 'plus catalog' },
            { value: 'scrypted', label: 'plugin catalog' },
          ] as const
        ).map((o) => (
          <Button
            variant="unstyled"
            key={o.value}
            type="button"
            onClick={() => {
              setError(null)
              setSuccess(null)
              setKind(o.value)
            }}
            className={[
              'px-3 py-1.5 text-xs transition-colors',
              kind === o.value
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
            ].join(' ')}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {kind === 'frigate' && (
        <PlusCatalogSection
          trpc={trpc}
          onRegistered={(message) => {
            setSuccess(message)
            onRegistered()
          }}
          onError={setError}
          onPrefillUpload={onPrefillUpload}
        />
      )}

      {kind === 'scrypted' && (
        <PluginCatalogTab
          trpc={trpc}
          onImported={() => {
            setSuccess(t('sources.pluginCatalogImported'))
            onRegistered()
          }}
        />
      )}
    </div>
  )
}
