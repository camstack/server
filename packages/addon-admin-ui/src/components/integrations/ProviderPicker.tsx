import { Input, useAddonsList, useIntegrationsGetAvailableTypes } from '@camstack/ui-library'
import { Loader2, Search, Settings } from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { integrationDetailUrl } from '../../lib/integration-instance-selection'
import {
  sortByFriendlyName,
  splitIntegrationSections,
  systemAddonIdsOf,
} from '../../lib/integration-sections'
import { IntegrationCard, IntegrationCardGrid } from './integration-card'
import { IntegrationSection } from './integration-section'
import { shouldAutofocusSearch } from './search-autofocus'

/**
 * One thing an instance list can add (a notification target, a broker, a storage place): the
 * picker's other source. A provider that offers several kinds is one tile PER KIND, each with the
 * kind's own icon when it declares one, else the provider's.
 */
export interface PickableProvider {
  readonly addonId: string
  /** The kind this tile creates; absent for a provider without kinds. */
  readonly kind?: string
  readonly name: string
  readonly description: string
  readonly iconUrl?: string
}

/** The picker over a caller's providers instead of the integration types. */
export interface ProviderPickerInstanceSource {
  readonly providers: readonly PickableProvider[]
  readonly onPick: (addonId: string, kind: string | undefined) => void
}

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
  /**
   * List these providers instead of the integration types (an instance list's Add): a pick hands
   * the provider back through `onPick`, and `onSelect` is not called.
   */
  source?: ProviderPickerInstanceSource
}

/** One tile, whichever source it came from. */
interface PickerEntry {
  readonly key: string
  readonly addonId: string
  readonly iconUrl?: string
  readonly name: string
  readonly description: string
  readonly open: () => void
  readonly footer: ReactElement | null
}

function matchesQuery(entry: Pick<PickerEntry, 'addonId' | 'name' | 'description'>, q: string) {
  return `${entry.name} ${entry.description} ${entry.addonId}`.toLowerCase().includes(q)
}

export function ProviderPicker({
  onSelect,
  onClose,
  pendingAddonId = null,
  source,
}: ProviderPickerProps) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const typesQuery = useIntegrationsGetAvailableTypes(undefined, {
    enabled: source === undefined,
  })
  const providerTypes = source === undefined ? typesQuery.data : undefined
  const isLoading = source === undefined && typesQuery.isLoading

  useEffect(() => {
    if (isLoading || !shouldAutofocusSearch()) return
    searchRef.current?.focus()
  }, [isLoading])

  const { data: installedAddons } = useAddonsList(undefined)
  const isAnyPending = pendingAddonId !== null
  const entries = useMemo((): readonly PickerEntry[] => {
    if (source !== undefined) {
      return source.providers.map((provider) => ({
        ...provider,
        key:
          provider.kind === undefined ? provider.addonId : `${provider.addonId}-${provider.kind}`,
        open: () => source.onPick(provider.addonId, provider.kind),
        footer: null,
      }))
    }
    return (providerTypes ?? []).map((provider): PickerEntry => {
      const isUniqueExisting =
        provider.instanceMode === 'unique' && provider.existingInstances.length > 0
      return {
        key: provider.addonId,
        addonId: provider.addonId,
        name: provider.name,
        description: provider.description ?? '',
        open: () => {
          const existing = provider.existingInstances[0]
          if (isUniqueExisting && existing !== undefined) {
            onClose()
            navigate(integrationDetailUrl(provider.addonId, existing.id))
          } else {
            onSelect(
              provider.addonId,
              provider.instanceMode,
              provider.discoveryMode,
              provider.providerLabel ?? provider.name,
              provider.kind,
              provider.brokerKind,
              provider.mode,
              provider.canTest,
            )
          }
        },
        footer: isUniqueExisting ? (
          <span className="flex items-center gap-1 text-xs font-medium text-foreground-subtle">
            <Settings className="h-3 w-3" />
            {t('integrations.manage')}
          </span>
        ) : null,
      }
    })
  }, [source, providerTypes, onClose, onSelect, navigate, t])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q.length === 0 ? entries : entries.filter((entry) => matchesQuery(entry, q))
  }, [entries, query])

  const sections = useMemo(() => {
    const split = splitIntegrationSections(filtered, systemAddonIdsOf(installedAddons))
    return {
      providers: sortByFriendlyName(split.providers, i18n.language),
      system: sortByFriendlyName(split.system, i18n.language),
    }
  }, [filtered, installedAddons, i18n.language])

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-surface animate-pulse" />
        ))}
      </div>
    )
  }

  const renderCards = (list: readonly PickerEntry[]): ReactElement => (
    <IntegrationCardGrid>
      {list.map((entry) => (
        <IntegrationCard
          key={entry.key}
          testId={`provider-card-${entry.key}`}
          buttonTestId={`provider-pick-${entry.key}`}
          addonId={entry.addonId}
          {...(entry.iconUrl !== undefined ? { iconUrl: entry.iconUrl } : {})}
          name={entry.name}
          openLabel={entry.name}
          disabled={isAnyPending}
          onOpen={entry.open}
          body={
            entry.description.length > 0 ? (
              <p className="line-clamp-2 text-xs text-foreground-muted">{entry.description}</p>
            ) : (
              <span />
            )
          }
          footer={
            pendingAddonId === entry.addonId ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              entry.footer
            )
          }
        />
      ))}
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
          data-dialog-autofocus
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
          {entries.length === 0
            ? t('integrations.noProviders')
            : t('integrations.noProvidersMatch', 'No integrations match your search.')}
        </div>
      )}
    </div>
  )
}
