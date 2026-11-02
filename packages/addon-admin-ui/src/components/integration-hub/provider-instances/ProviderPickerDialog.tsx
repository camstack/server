/**
 * Which provider a new instance goes to: a tile per provider that can take one, like the kind
 * picker of Notification targets. Offered only when there is a choice — one provider opens its
 * form directly.
 */
import { ItemFormDialog } from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

export interface PickableProvider {
  readonly addonId: string
  readonly name: string
  readonly description: string
}

export interface ProviderPickerDialogProps {
  readonly providers: readonly PickableProvider[]
  readonly title: string
  readonly onPick: (addonId: string) => void
  readonly onCancel: () => void
}

export function ProviderPickerDialog({
  providers,
  title,
  onPick,
  onCancel,
}: ProviderPickerDialogProps): ReactElement {
  const { t } = useTranslation()
  return (
    <ItemFormDialog open onClose={onCancel} title={title} width="lg">
      <p className="mb-3 text-xs text-foreground-muted">
        {t('providerInstances.pickProvider', 'Choose which provider the new one belongs to.')}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {providers.map((provider) => (
          // ui-check-ok: provider tile — name + description card in a grid, not a toolbar Button
          <button
            key={provider.addonId}
            type="button"
            onClick={() => onPick(provider.addonId)}
            className="flex flex-col items-start gap-1 rounded-lg border border-border bg-surface px-3 py-3 text-left text-xs transition-colors hover:border-primary/50 hover:bg-surface-hover"
          >
            <span className="font-medium text-foreground">{provider.name}</span>
            {provider.description.length > 0 && (
              <span className="line-clamp-2 text-[11px] text-foreground-subtle">
                {provider.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </ItemFormDialog>
  )
}
