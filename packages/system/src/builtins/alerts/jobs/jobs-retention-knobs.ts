/**
 * The two retention knobs of the jobs ledger, as the `retention-source` capability lists them
 * (D1084). A read of the settings the alert center already holds; the prune on write reads the
 * same values (`resolveJobRetention`).
 */
import type { RetentionKnob } from '@camstack/types'
import type { JobRetention } from './job-policy.js'

export const ALERT_CENTER_ADDON_ID = 'alert-center'
const CAP = 'jobs'

export const DEFAULT_JOB_RETENTION: JobRetention = { retentionDays: 30, maxPerOwner: 200 }

export interface JobRetentionConfig {
  readonly jobsRetentionDays: number
  readonly jobsMaxPerOwner: number
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? value : fallback
}

/** The configured values; a missing or invalid one falls back to the default. */
export function resolveJobRetention(config: Partial<JobRetentionConfig>): JobRetention {
  return {
    retentionDays: positiveOr(
      config.jobsRetentionDays ?? Number.NaN,
      DEFAULT_JOB_RETENTION.retentionDays,
    ),
    maxPerOwner: positiveOr(
      config.jobsMaxPerOwner ?? Number.NaN,
      DEFAULT_JOB_RETENTION.maxPerOwner,
    ),
  }
}

interface KnobSpec {
  readonly key: keyof JobRetentionConfig
  readonly label: string
  readonly unit: 'days' | 'count'
  readonly defaultValue: number
  readonly max: number
  readonly value: (retention: JobRetention) => number
}

const SPECS: readonly KnobSpec[] = [
  {
    key: 'jobsRetentionDays',
    label: 'Finished jobs',
    unit: 'days',
    defaultValue: DEFAULT_JOB_RETENTION.retentionDays,
    max: 365,
    value: (r) => r.retentionDays,
  },
  {
    key: 'jobsMaxPerOwner',
    label: 'Finished jobs kept per user',
    unit: 'count',
    defaultValue: DEFAULT_JOB_RETENTION.maxPerOwner,
    max: 5000,
    value: (r) => r.maxPerOwner,
  },
]

export function jobsRetentionKnobs(config: Partial<JobRetentionConfig>): readonly RetentionKnob[] {
  const retention = resolveJobRetention(config)
  return SPECS.map(
    (spec): RetentionKnob => ({
      id: `${ALERT_CENTER_ADDON_ID}:${spec.key}`,
      owner: ALERT_CENTER_ADDON_ID,
      key: spec.key,
      labelKey: `retention.${ALERT_CENTER_ADDON_ID}.${spec.key}`,
      label: spec.label,
      group: 'jobs',
      unit: spec.unit,
      defaultValue: spec.defaultValue,
      value: spec.value(retention),
      min: 1,
      max: spec.max,
      zeroMeansForever: false,
      scope: 'cluster',
      write: {
        method: 'updateScopedSettings',
        addonId: ALERT_CENTER_ADDON_ID,
        cap: CAP,
        scope: 'cluster',
        key: spec.key,
      },
    }),
  )
}
