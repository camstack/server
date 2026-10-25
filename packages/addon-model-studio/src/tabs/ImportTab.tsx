/**
 * Import — Custom only (upload | URL). plugin catalog / plus catalog live under Catalog.
 */
import { useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import { CustomTab } from './RegisterTab.js'
import type { UploadPrefill } from './PlusCatalogSourceSections.js'
import { useT } from '../i18n/index.js'

interface ImportTabProps {
  readonly trpc: AddonPageProps['trpc']
  readonly onRegistered: () => void
  readonly initialPrefill?: UploadPrefill | null
  readonly onPrefillConsumed?: () => void
}

export function ImportTab({
  trpc,
  onRegistered,
  initialPrefill = null,
  onPrefillConsumed,
}: ImportTabProps) {
  const { t } = useT()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [customPrefill, setCustomPrefill] = useState<UploadPrefill | null>(initialPrefill)

  useEffect(() => {
    if (initialPrefill !== null) setCustomPrefill(initialPrefill)
  }, [initialPrefill])

  return (
    <div className="space-y-4" data-testid="import-tab">
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

      <CustomTab
        trpc={trpc}
        onRegistered={(message) => {
          setSuccess(message ?? t('importTab.registered'))
          setError(null)
          onRegistered()
        }}
        initialPrefill={customPrefill}
        onPrefillConsumed={() => {
          setCustomPrefill(null)
          onPrefillConsumed?.()
        }}
      />
    </div>
  )
}
