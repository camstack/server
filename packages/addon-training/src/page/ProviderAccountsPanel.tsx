/**
 * Providers tab — the cloud accounts jobs run on.
 *
 * Accounts are `integration-instances` records, edited with the admin instances table
 * (`/training/providers`); this tab lists them read-only and leads there. The credentials never
 * reach the page: `describe` answers `configured`, never a value.
 */
import type { JSX } from 'react'
import type { TrainingProviderDescriptor } from '@camstack/types'
import { Badge, Button, EmptyState, type AddonPageProps } from '@camstack/ui-library'
import { Cloud } from 'lucide-react'
import { useT } from '../i18n/index.js'

/** The admin route that edits the accounts (the instances table over `training-provider`). */
export const TRAINING_PROVIDERS_PATH = '/training/providers'

export interface ProviderAccountsPanelProps {
  readonly navigate: AddonPageProps['navigate']
  /** The enabled accounts, or null while the list is not known (never "none yet"). */
  readonly providers: readonly TrainingProviderDescriptor[] | null
}

export function ProviderAccountsPanel({
  navigate,
  providers,
}: ProviderAccountsPanelProps): JSX.Element {
  const { t } = useT()
  const manage = (
    <Button
      type="button"
      size="sm"
      data-testid="training-providers-manage"
      onClick={() => navigate(TRAINING_PROVIDERS_PATH)}
    >
      {t('providers.manage')}
    </Button>
  )
  if (providers !== null && providers.length === 0) {
    return (
      <EmptyState
        icon={Cloud}
        title={t('providers.empty')}
        description={t('providers.emptyHint')}
        action={manage}
      />
    )
  }
  return (
    <div className="flex flex-col gap-3" data-testid="training-providers-panel">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-foreground-subtle">{t('providers.hint')}</p>
        {manage}
      </div>
      <ul className="divide-y divide-border rounded border border-border">
        {(providers ?? []).map((provider) => (
          <li
            key={provider.entryId}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span className="text-foreground">
              {provider.name} <span className="text-foreground-subtle">· {provider.label}</span>
            </span>
            <Badge variant={provider.configured ? 'success' : 'default'}>
              {provider.configured ? t('providers.configured') : t('providers.notConfigured')}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}
