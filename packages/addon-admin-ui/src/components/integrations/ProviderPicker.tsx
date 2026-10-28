import { Input, useAddonsList, useIntegrationsGetAvailableTypes } from '@camstack/ui-library'
import { Loader2, Search, Settings } from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { integrationDetailUrl } from '../../lib/integration-instance-selection'
import { splitIntegrationSections, systemAddonIdsOf } from '../../lib/integration-sections'
import { IntegrationCard, IntegrationCardGrid } from './integration-card'
import { IntegrationSection } from './integration-section'
import { shouldAutofocusSearch } from './search-autofocus'

interface ProviderPickerProps {
  onSelect: (
    addonId: string,
    instanceMode: string,
    discoveryMode: string,
    displayName: string,
    kind: 'device-adoption' | 'device-provider',
    brokerKind: string | null,
    mode: 'standalone' | 'account' | 'broker',
    /** Whether this integration declares a pre-creation connection test. */
    canTest: boolean,
  ) => void
  onClose: () => void
  /** Provider currently being created. All buttons are disabled; this one shows a spinner. */
  pendingAddonId?: string | null
}

export function ProviderPicker({ onSelect, onClose, pendingAddonId = null }: ProviderPickerProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: providerTypes, isLoading } = useIntegrationsGetAvailableTypes()

  useEffect(() => {
    if (isLoading || !shouldAutofocusSearch()) return
    searchRef.current?.focus()
  }, [isLoading])

  const filtered = useMemo(() => {
    const list = providerTypes ?? []
    const q = query.trim().toLowerCase()
    if (q.length === 0) return list
    return list.filter((p) => {
      const hay = `${p.name} ${p.description ?? ''} ${p.addonId}`.toLowerCase()
      return hay.includes(q)
    })
  }, [providerTypes, query])

  const { data: installedAddons } = useAddonsList(undefined)
  const sections = useMemo(
    () => splitIntegrationSections(filtered, systemAddonIdsOf(installedAddons)),
    [filtered, installedAddons],
  )

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-surface animate-pulse" />
        ))}
      </div>
    )
  }

  const isAnyPending = pendingAddonId !== null

  const renderCards = (list: readonly (typeof filtered)[number][]): ReactElement => (
    <IntegrationCardGrid>
      {list.map((provider) => {
        const isUniqueExisting =
          provider.instanceMode === 'unique' && provider.existingInstances.length > 0
        const isThisPending = pendingAddonId === provider.addonId
        return (
          <IntegrationCard
            key={provider.addonId}
            testId={`provider-card-${provider.addonId}`}
            buttonTestId={`provider-pick-${provider.addonId}`}
            addonId={provider.addonId}
            name={provider.name}
            openLabel={provider.name}
            disabled={isAnyPending}
            onOpen={() => {
              if (isUniqueExisting) {
                const existingId = provider.existingInstances[0]!.id
                onClose()
                navigate(integrationDetailUrl(provider.addonId, existingId))
              } else {
                onSelect(
                  provider.addonId,
                  provider.instanceMode,
                  provider.discoveryMode,
                  provider.name,
                  provider.kind,
                  provider.brokerKind,
                  provider.mode,
                  provider.canTest,
                )
              }
            }}
            body={
              provider.description ? (
                <p className="line-clamp-2 text-xs text-foreground-muted">{provider.description}</p>
              ) : (
                <span />
              )
            }
            footer={
              isThisPending ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : isUniqueExisting ? (
                <span className="flex items-center gap-1 text-xs font-medium text-foreground-subtle">
                  <Settings className="h-3 w-3" />
                  {t('integrations.manage')}
                </span>
              ) : null
            }
          />
        )
      })}
    </IntegrationCardGrid>
  )

  return (
    <div className="space-y-3" data-testid="provider-picker">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
          aria-hidden
        />
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('integrations.searchProviders', 'Search integrations…')}
          className="pl-8"
          data-testid="provider-picker-search"
          aria-label={t('integrations.searchProviders', 'Search integrations…')}
        />
      </div>

      {sections.providers.length > 0 && (
        <IntegrationSection kind="providers">{renderCards(sections.providers)}</IntegrationSection>
      )}
      {sections.system.length > 0 && (
        <IntegrationSection kind="system">{renderCards(sections.system)}</IntegrationSection>
      )}

      {filtered.length === 0 && (
        <div className="py-8 text-center text-xs text-foreground-subtle">
          {(providerTypes ?? []).length === 0
            ? t('integrations.noProviders')
            : t('integrations.noProvidersMatch', 'No integrations match your search.')}
        </div>
      )}
    </div>
  )
}
