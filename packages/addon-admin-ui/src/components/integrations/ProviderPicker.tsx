import { Input, useIntegrationsGetAvailableTypes } from '@camstack/ui-library'
import { Loader2, Search, Settings } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

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

  const { data: providerTypes, isLoading } = useIntegrationsGetAvailableTypes()

  const filtered = useMemo(() => {
    const list = providerTypes ?? []
    const q = query.trim().toLowerCase()
    if (q.length === 0) return list
    return list.filter((p) => {
      const hay = `${p.name} ${p.description ?? ''} ${p.addonId}`.toLowerCase()
      return hay.includes(q)
    })
  }, [providerTypes, query])

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 p-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-surface animate-pulse" />
        ))}
      </div>
    )
  }

  const isAnyPending = pendingAddonId !== null

  return (
    <div className="space-y-3" data-testid="provider-picker">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('integrations.searchProviders', 'Search integrations…')}
          className="pl-8"
          data-testid="provider-picker-search"
          aria-label={t('integrations.searchProviders', 'Search integrations…')}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {filtered.map((provider) => {
          const isUniqueExisting =
            provider.instanceMode === 'unique' && provider.existingInstances.length > 0
          const isThisPending = pendingAddonId === provider.addonId
          const isDisabled = isAnyPending

          return (
            // ui-check-ok: provider tile — 2-col grid like notification KindPicker
            <button
              key={provider.addonId}
              type="button"
              disabled={isDisabled}
              data-testid={`provider-pick-${provider.addonId}`}
              onClick={() => {
                if (isDisabled) return
                if (isUniqueExisting) {
                  const existingId = provider.existingInstances[0]!.id
                  onClose()
                  navigate(`/integrations/${existingId}`)
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
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3 text-center text-xs hover:border-primary/50 hover:bg-surface-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-border"
            >
              {provider.iconUrl ? (
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0"
                  /* ui-check-ok: per-provider brand tint from hub catalog */
                  style={{ backgroundColor: `${provider.color}15` }}
                >
                  <img src={provider.iconUrl} alt="" className="h-5 w-5" />
                </div>
              ) : (
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0"
                  /* ui-check-ok: per-provider brand tint from hub catalog */
                  style={{ backgroundColor: `${provider.color}15` }}
                >
                  {/* ui-check-ok: per-provider brand tint from hub catalog */}
                  <span className="text-sm" style={{ color: provider.color }}>
                    ◉
                  </span>
                </div>
              )}
              <p className="w-full truncate text-xs font-semibold text-foreground">
                {provider.name}
              </p>
              {provider.description ? (
                <p className="w-full line-clamp-2 text-[10px] text-foreground-subtle">
                  {provider.description}
                </p>
              ) : null}
              {isThisPending ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : isUniqueExisting ? (
                <span className="flex items-center gap-1 text-[10px] font-medium text-foreground-subtle">
                  <Settings className="h-3 w-3" />
                  {t('integrations.manage')}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

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
