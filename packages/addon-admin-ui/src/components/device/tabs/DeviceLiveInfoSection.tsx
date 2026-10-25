import { useMemo } from 'react'
import { Loader2, Activity } from 'lucide-react'

import { useDeviceManagerGetDeviceAggregate } from '@camstack/ui-library'
import { useEventInvalidation } from '../../../hooks/useEventInvalidation'
import { FormBuilder } from '../../form-builder/FormBuilder'
import type {
  ConfigUISchemaWithValues,
  ConfigSectionWithValues,
  ConfigFieldWithValue,
  ConfigField,
} from '../../../types/config-ui'
import { useTranslation } from 'react-i18next'

/**
 * DeviceLiveInfoSection — renders the `live` half of
 * `deviceManager.getDeviceAggregate` on the Overview tab.
 *
 * Live contributions are read-only runtime info (pipeline-orchestrator
 * status, stream-broker active URLs, motion/audio counters, …) contributed
 * by every capability provider with `exposesDeviceSettings: true`. They
 * used to bleed into the Config tab, which was confusing — "these look
 * like settings but the Save button does nothing for them". Live info
 * belongs next to the live stream viewer on Overview; settings stay in
 * Config.
 *
 * Both this component and `DeviceAggregateSection` hit the same
 * `['device-aggregate', deviceId]` query key, so react-query de-dupes the
 * tRPC call even when both tabs are mounted. Polling cadence stays on
 * the Config-side pause-while-editing logic; Overview just reads the
 * same cached payload.
 */
export function DeviceLiveInfoSection({ deviceId }: { deviceId: number }) {
  const { t } = useTranslation()
  // Live aggregate is invalidated on every signal that can mutate
  // its contribution surface: pipeline metrics tick (covers detection
  // phase / fps), camera assignment changes, broker stats tick,
  // device-binding changes, and device online/offline transitions.
  useEventInvalidation(
    ['deviceManager', 'getDeviceAggregate'],
    [
      'pipeline.camera-metrics-snapshot',
      'pipeline.camera-assigned',
      'pipeline.camera-unassigned',
      'pipeline.camera-updated',
      'stream-broker.metrics-snapshot',
      'capability.binding-changed',
      'device.online',
      'device.offline',
      'device.streams-registered',
      'device.streams-unregistered',
    ],
  )

  const { data: aggregateData, isLoading } = useDeviceManagerGetDeviceAggregate(
    { deviceId },
    {
      refetchInterval: 5_000,
      enabled: Number.isFinite(deviceId),
    },
  )

  const liveSchema = aggregateData?.live ?? null

  // Force every field readonly before rendering — the backend already
  // tags most of them, but we add a defensive second pass so that any
  // contributor forgetting the flag doesn't accidentally surface an
  // editable control on what should be observation-only info.
  const readonlySchema = useMemo(() => forceReadonlyOnAllFields(liveSchema), [liveSchema])
  const values = useMemo(() => extractValues(readonlySchema), [readonlySchema])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
        <span className="text-[11px]">
          {t('device.deviceLiveInfoSection.loadingLiveInfo', 'Loading live info…')}
        </span>
      </div>
    )
  }

  if (!readonlySchema || readonlySchema.sections.length === 0) {
    // No contributor emitted any `live` section for this device — common
    // for brand-new or inactive devices. Don't render chrome just to
    // say "nothing here": stay invisible so the Overview layout doesn't
    // collapse with an empty card.
    return null
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-foreground-subtle" />
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {t('device.deviceLiveInfoSection.liveInfo', 'Live Info')}
        </h2>
      </div>
      <div className="p-4">
        <FormBuilder schema={readonlySchema} values={values} onChange={() => {}} disabled />
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function forceReadonlyOnAllFields(
  schema: ConfigUISchemaWithValues | null,
): ConfigUISchemaWithValues | null {
  if (!schema) return null
  return {
    ...(schema.tabs ? { tabs: schema.tabs } : {}),
    sections: schema.sections.map(forceReadonlyOnSection),
  }
}

function forceReadonlyOnSection(section: ConfigSectionWithValues): ConfigSectionWithValues {
  return {
    ...section,
    fields: section.fields.map(forceReadonlyOnField),
  }
}

function forceReadonlyOnField(field: ConfigFieldWithValue): ConfigFieldWithValue {
  if (
    field.type === 'separator' ||
    field.type === 'info' ||
    field.type === 'button' ||
    field.type === 'object-array'
  ) {
    return field
  }
  return { ...field, readonlyField: true }
}

function extractValues(schema: ConfigUISchemaWithValues | null): Record<string, unknown> {
  if (!schema) return {}
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type === 'separator' || field.type === 'info' || field.type === 'button') continue
      const f = field as ConfigField & { key: string; value?: unknown }
      if (!('key' in f) || !f.key) continue
      out[f.key] = (field as { value?: unknown }).value
    }
  }
  return out
}
