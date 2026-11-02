/**
 * The Logs / Events stream of one addon, under an integration's settings or under a
 * provider-instances list. The same section on both, so a `?section=activity` link lands on either.
 */
import { Bell, ScrollText, type LucideIcon } from 'lucide-react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { Button, EventStream, LogStream } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

import { ACTIVITY_SECTION } from '../../lib/integration-hub-url'
import { IntegrationSection } from './IntegrationSection'

/** Default height of the Logs / Events scroll region. */
const ACTIVITY_MAX_HEIGHT = 'max-h-72'

type ActivityKind = 'logs' | 'events'

const ACTIVITY_KINDS: readonly {
  kind: ActivityKind
  labelKey: string
  icon: LucideIcon
}[] = [
  { kind: 'logs', labelKey: 'common.logs', icon: ScrollText },
  { kind: 'events', labelKey: 'common.events', icon: Bell },
]

export interface IntegrationActivityProps {
  readonly addonId: string
  /** A row of controls above the stream (the list's provider chips); the header stays one toggle. */
  readonly switcher?: ReactNode
}

export function IntegrationActivity({ addonId, switcher }: IntegrationActivityProps): ReactElement {
  const { t } = useTranslation()
  const [kind, setKind] = useState<ActivityKind>('logs')
  return (
    <IntegrationSection
      id={ACTIVITY_SECTION}
      title={t('integrationHub.addonIntegrationBody.activity', 'Activity')}
      framed
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t('integrationHub.addonIntegrationBody.activityStream', 'Activity stream')}
            className="flex items-center gap-1"
          >
            {ACTIVITY_KINDS.map(({ kind: k, labelKey, icon: Icon }) => (
              <Button
                variant="unstyled"
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  kind === k
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                <Icon className="h-3 w-3" aria-hidden />
                {t(labelKey)}
              </Button>
            ))}
          </div>
        </div>
      }
    >
      {switcher !== undefined && <div className="px-3 pt-2">{switcher}</div>}
      {kind === 'logs' ? (
        <LogStream addonId={addonId} maxHeight={ACTIVITY_MAX_HEIGHT} showFilters={false} />
      ) : (
        <EventStream addonId={addonId} category="addon.*" maxHeight={ACTIVITY_MAX_HEIGHT} />
      )}
    </IntegrationSection>
  )
}
