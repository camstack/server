import { StatusBadge, useIntegrationsList } from '@camstack/ui-library'
import { ProviderIcon } from '../shared/ProviderIcon'
import { Trans, useTranslation } from 'react-i18next'

export function IntegrationUsage() {
  const { t } = useTranslation()
  const { data, isLoading, isError } = useIntegrationsList(undefined, {
    refetchInterval: 10_000,
  })

  const integrations = data ?? []

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-xs font-semibold text-foreground-subtle uppercase tracking-wider mb-3">
        {t('metrics.integrationUsage.integrationUsage', 'Integration Usage')}
      </h2>

      {isLoading && (
        <div className="text-xs text-foreground-subtle animate-pulse">
          {t('metrics.integrationUsage.loading', 'Loading...')}
        </div>
      )}

      {isError && (
        <div className="text-xs text-danger">
          {t('metrics.integrationUsage.failedToLoadData', 'Failed to load data')}
        </div>
      )}

      {!isLoading && !isError && integrations.length === 0 && (
        <div className="text-xs text-foreground-subtle">
          {t('common.noData', 'No data available')}
        </div>
      )}

      {!isLoading && !isError && integrations.length > 0 && (
        <>
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-border">
            <span className="text-xs text-foreground-subtle">
              <Trans
                i18nKey="metrics.integrationUsage.count"
                values={{ count: integrations.length }}
                components={{ b: <span className="text-foreground font-semibold" /> }}
              />
            </span>
          </div>

          <div className="space-y-2">
            {integrations.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderIcon type={i.addonId} size="sm" />
                  <span className="text-xs text-foreground font-medium truncate">{i.name}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={i.enabled ? 'enabled' : 'disabled'} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
