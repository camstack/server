/**
 * Suggested defaults (D1104) — the cluster default for the detection stream
 * profile and rate, suggested from what each node serving cameras can decode.
 * Follows the Auto tune contract: the plan is shown, the operator confirms,
 * nothing is applied automatically. A null recommended field means "no
 * suggestion", never a made-up value. The apply answers `stale` when the
 * recommendation moved; the fresh plan replaces the shown one and the operator
 * confirms again.
 */
import type {
  ClusterDetectionDefaults,
  DetectionDefaultsPlan,
  DetectionDefaultsReason,
} from '@camstack/types'
import {
  type AddonPageProps,
  ConfirmActionButton,
  ErrorBox,
  SECTION_BODY,
  SectionCard,
  SettingRow,
  Skeleton,
  TEXT_HINT,
} from '@camstack/ui-library'
import { RotateCcw, Sparkles, Wand2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n/index.js'

type Trpc = AddonPageProps['trpc']
type TFn = ReturnType<typeof useT>['t']

type Notice = 'applied' | 'stale' | null

function profileText(t: TFn, profile: ClusterDetectionDefaults['detectionStreamProfile']): string {
  return profile === undefined ? t('defaults.builtIn') : t(`defaults.profileValue.${profile}`)
}

function fpsText(t: TFn, fps: number | undefined): string {
  return fps === undefined ? t('defaults.builtIn') : t('defaults.fpsValue', { fps })
}

/** One readable sentence per reason the recommender gave. */
export function reasonText(t: TFn, reason: DetectionDefaultsReason): string {
  switch (reason.kind) {
    case 'no-serving-nodes':
      return t('defaults.reason.noServingNodes')
    case 'cpu-only':
      return t('defaults.reason.cpuOnly', {
        node: reason.nodeId,
        dimension: t(`defaults.dimension.${reason.dimension}`),
      })
    case 'decode-4k-below-cameras':
      return t('defaults.reason.decode4k', {
        node: reason.nodeId,
        max: reason.maxStreams,
        cameras: reason.cameras,
      })
    case 'unknown':
      return t('defaults.reason.unknown', {
        node: reason.nodeId,
        dimension: t(`defaults.dimension.${reason.dimension}`),
        missing: t(`defaults.missing.${reason.missing}`),
      })
  }
}

function Compare(props: {
  readonly label: string
  readonly current: string
  readonly suggested: string | null
  readonly t: TFn
}): ReactNode {
  const { label, current, suggested, t } = props
  return (
    <SettingRow label={label}>
      <span className="text-foreground-muted">{t('defaults.colCurrent')}: </span>
      <span className="text-foreground">{current}</span>
      <span className="text-foreground-muted"> · {t('defaults.colSuggested')}: </span>
      <span className={suggested === null ? 'text-foreground-subtle' : 'text-foreground'}>
        {suggested ?? t('defaults.noSuggestion')}
      </span>
    </SettingRow>
  )
}

export function SuggestedDefaultsCard({ trpc }: { readonly trpc: Trpc }): ReactNode {
  const { t } = useT()
  const [plan, setPlan] = useState<DetectionDefaultsPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const load = useCallback(() => {
    trpc.pipelineOrchestrator.planDetectionDefaults
      .query({})
      .then((next) => {
        setPlan(next)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [trpc])

  useEffect(() => {
    load()
  }, [load])

  const rec = plan?.recommendation ?? null
  const hasSuggestion =
    rec !== null && (rec.detectionStreamProfile !== null || rec.detectionFps !== null)
  const hasStored =
    plan !== null &&
    (plan.current.detectionStreamProfile !== undefined || plan.current.detectionFps !== undefined)

  return (
    <SectionCard headingId="nb-defaults" title={t('defaults.title')} icon={Sparkles}>
      <div className={`${SECTION_BODY} space-y-2 text-xs`}>
        <p>{t('defaults.intro')}</p>
        {error !== null && <ErrorBox message={t('defaults.loadError', { error })} />}
        {error === null && plan === null && <Skeleton className="h-16 w-full" />}
        {plan !== null && rec !== null && (
          <>
            {notice === 'stale' && <p className="text-warning">{t('defaults.stale')}</p>}
            {notice === 'applied' && <p className="text-success">{t('defaults.applied')}</p>}
            <div>
              <Compare
                t={t}
                label={t('defaults.profile')}
                current={profileText(t, plan.current.detectionStreamProfile)}
                suggested={
                  rec.detectionStreamProfile === null
                    ? null
                    : profileText(t, rec.detectionStreamProfile)
                }
              />
              <Compare
                t={t}
                label={t('defaults.fps')}
                current={fpsText(t, plan.current.detectionFps)}
                suggested={rec.detectionFps === null ? null : fpsText(t, rec.detectionFps)}
              />
            </div>
            {rec.reasons.length > 0 && (
              <ul className={`${TEXT_HINT} list-disc space-y-0.5 pl-4`}>
                {rec.reasons.map((reason) => (
                  <li key={JSON.stringify(reason)}>{reasonText(t, reason)}</li>
                ))}
              </ul>
            )}
            <p className={TEXT_HINT}>
              {plan.overrides.count === 0
                ? t('defaults.overridesNone')
                : t('defaults.overrides', { count: plan.overrides.count })}
            </p>
            <p className={TEXT_HINT}>{t('defaults.restartNote')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {hasSuggestion ? (
                <ConfirmActionButton
                  label={t('defaults.apply')}
                  icon={Wand2}
                  title={t('defaults.applyTitle')}
                  description={t('defaults.applyDescription')}
                  confirmLabel={t('defaults.apply')}
                  triggerVariant="primary"
                  confirmVariant="primary"
                  action={async () =>
                    trpc.pipelineOrchestrator.applyDetectionDefaults.mutate({
                      planHash: plan.planHash,
                    })
                  }
                  onSuccess={(result) => {
                    if (result.kind === 'stale') {
                      setPlan(result.plan)
                      setNotice('stale')
                    } else {
                      setNotice('applied')
                      load()
                    }
                  }}
                />
              ) : (
                <p className={TEXT_HINT}>{t('defaults.nothingToApply')}</p>
              )}
              {hasStored && (
                <ConfirmActionButton
                  label={t('defaults.reset')}
                  icon={RotateCcw}
                  title={t('defaults.resetTitle')}
                  description={t('defaults.resetDescription')}
                  confirmLabel={t('defaults.reset')}
                  triggerVariant="outline"
                  action={async () =>
                    trpc.pipelineOrchestrator.setClusterDetectionDefaults.mutate({})
                  }
                  onSuccess={() => {
                    setNotice(null)
                    load()
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
