/**
 * Scheduler quick body: when it fires next, its rules, what it triggers, and
 * its last fires.
 */
import type { Scheduler, SchedulerStatus } from '@camstack/types'
import {
  Badge,
  useSchedulersGetStatus,
  useSchedulersGetTraces,
  useSchedulersPreview,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { actionDeviceIds } from '../action-devices'
import {
  type QuickFact,
  QuickDeviceLinks,
  QuickFacts,
  QuickRunList,
  QuickSection,
} from '../QuickParts'

const POLL_MS = 10_000

export interface SchedulerQuickBodyProps {
  readonly scheduler: Scheduler
  /** Opens the editor on the fire. */
  readonly onOpenRun: (runId: string) => void
}

type Translate = ReturnType<typeof useTranslation>['t']

function holdLabel(status: SchedulerStatus | undefined, t: Translate): string {
  if (status === undefined) return '-'
  if (status.hold === null) return t('schedulers.status.idle', 'Idle')
  if (status.hold.suspendedInactive) return t('schedulers.status.paused', 'Paused')
  if (status.hold.targets.some((target) => target.status === 'gave-up')) {
    return t('schedulers.status.gaveUp', 'Gave up')
  }
  return t('schedulers.status.holding', 'Holding')
}

export function SchedulerQuickBody({ scheduler, onOpenRun }: SchedulerQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const traces = useSchedulersGetTraces({ schedulerId: scheduler.id }, { refetchInterval: POLL_MS })
  const status = useSchedulersGetStatus({}, { refetchInterval: POLL_MS })
  const preview = useSchedulersPreview({ schedulerId: scheduler.id })
  const mine = status.data?.find((s) => s.schedulerId === scheduler.id)
  const now = Date.now()
  const next = (preview.data?.points ?? [])
    .map((point) => point.at)
    .filter((at): at is number => at !== null && at > now)
    .sort((a, b) => a - b)[0]
  const steps = scheduler.profiles.flatMap((p) => p.points.flatMap((point) => point.steps))
  const facts: QuickFact[] = [
    {
      key: t('build.quickModal.status', 'Status'),
      value: (
        <Badge variant="neutral">
          {scheduler.enabled ? holdLabel(mine, t) : t('schedulers.status.off', 'Off')}
        </Badge>
      ),
    },
    {
      key: t('build.quickModal.nextFire', 'Next fire'),
      value:
        next === undefined
          ? t('build.quickModal.noMoreToday', 'Nothing more today')
          : new Date(next).toLocaleTimeString(),
    },
    { key: t('schedulers.list.priority', 'Priority'), value: String(scheduler.priority) },
    {
      key: t('build.quickModal.triggers', 'It triggers'),
      value: (
        <QuickDeviceLinks
          ids={actionDeviceIds(steps)}
          empty={t('build.quickModal.noDevices', 'No device named directly')}
        />
      ),
    },
  ]
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <QuickFacts items={facts} />
      </QuickSection>
      <QuickSection title={t('build.quickModal.rules', 'Rules')}>
        {scheduler.profiles.length === 0 ? (
          <p className="text-xs text-foreground-subtle">
            {t('build.quickModal.noProfiles', 'No profiles yet')}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {scheduler.profiles.map((profile) => (
              <li key={profile.id}>
                <span className="font-medium">{profile.name}</span>
                <span className="text-foreground-muted">
                  {' · '}
                  {profile.days.join(', ')}
                  {' · '}
                  {t('build.quickModal.pointCount', '{{count}} points', {
                    count: profile.points.length,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QuickSection>
      <QuickSection title={t('build.quickModal.lastFires', 'Last fires')}>
        <QuickRunList
          traces={traces.data?.traces}
          failed={traces.error !== null && traces.error !== undefined}
          emptyLabel={t('build.quickModal.neverFired', 'Never fired')}
          kind="fire"
          onOpenRun={onOpenRun}
        />
      </QuickSection>
    </>
  )
}
