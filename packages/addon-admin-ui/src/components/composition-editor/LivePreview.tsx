/**
 * The live preview line of one field: each (source, cap) the field reads is
 * subscribed through `useDeviceCapSlice` (pushed — no polling), and the value
 * is `previewField`, the composer's own evaluation (D676 ruling 10).
 *
 * A source device the device list does not know is SAID, never left waiting
 * forever; a device list that failed is said with its reason (D315).
 */
import {
  type CompositionFieldRead,
  type CompositionFieldSource,
  compositionSliceKey,
  compositionSourceKey,
  fieldReads,
} from '@camstack/types'
import { useDeviceCapSlice, useDeviceManagerListAll, useSystem } from '@camstack/ui-library'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { devicesByRef } from '../device/customize/device-refs'
import {
  formatLiveValue,
  type PickerDevice,
  toPickerDevices,
} from '../device/customize/source-picker-model'
import { type FieldPreview, previewField, type SliceReading } from './field-preview'

export interface LivePreviewProps {
  readonly source: CompositionFieldSource
}

type ReadingSink = (key: string, reading: SliceReading) => void

interface SliceProbeProps {
  readonly sliceKey: string
  readonly deviceId: number
  readonly capName: string
  readonly onReading: ReadingSink
}

function SliceProbe({ sliceKey, deviceId, capName, onReading }: SliceProbeProps): ReactNode {
  const system = useSystem()
  const slice = useDeviceCapSlice(system.trpcClient, deviceId, capName)
  useEffect(() => {
    onReading(sliceKey, slice === undefined ? { kind: 'pending' } : { kind: 'value', slice })
  }, [sliceKey, slice, onReading])
  return null
}

interface ResolvedSlice {
  readonly key: string
  readonly read: CompositionFieldRead
  readonly device: PickerDevice | undefined
}

/** One entry per (source, cap) the field reads, with the device that serves it. */
function resolveSlices(
  source: CompositionFieldSource,
  byRef: ReadonlyMap<string, PickerDevice>,
): readonly ResolvedSlice[] {
  const unique = new Map(fieldReads(source).map((r) => [compositionSliceKey(r.source, r.cap), r]))
  return [...unique].map(([key, read]) => ({
    key,
    read,
    device: byRef.get(compositionSourceKey(read.source)),
  }))
}

export function LivePreview({ source }: LivePreviewProps): ReactNode {
  const { t } = useTranslation()
  const all = useDeviceManagerListAll({ projection: 'slim' })
  const [readings, setReadings] = useState<ReadonlyMap<string, SliceReading>>(new Map())
  // Stable, so a probe's effect fires only when its slice changes.
  const onReading = useCallback<ReadingSink>((key, reading) => {
    setReadings((prev) => new Map([...prev, [key, reading]]))
  }, [])
  const byRef = devicesByRef(all.status === 'success' ? toPickerDevices(all.data) : [])
  const slices = resolveSlices(source, byRef)
  const unknownDevices =
    all.status === 'success'
      ? slices.filter((s) => s.device === undefined).map((s) => compositionSourceKey(s.read.source))
      : []
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      {slices.map((s) =>
        s.device === undefined ? null : (
          <SliceProbe
            key={s.key}
            sliceKey={s.key}
            deviceId={s.device.id}
            capName={s.read.cap}
            onReading={onReading}
          />
        ),
      )}
      <span className="text-foreground-subtle">{t('compositionEditor.preview.label')}</span>
      {all.status === 'error' ? (
        <span className="text-warning">
          {t('compositionEditor.preview.devicesFailed', { reason: all.error?.message ?? '' })}
        </span>
      ) : unknownDevices.length > 0 ? (
        <span className="text-warning">
          {t('compositionEditor.preview.unknownDevice', { sources: unknownDevices.join(', ') })}
        </span>
      ) : (
        <PreviewValue preview={previewField(source, readings, Date.now())} />
      )}
    </div>
  )
}

interface PreviewValueProps {
  readonly preview: FieldPreview
}

function PreviewValue({ preview }: PreviewValueProps): ReactNode {
  const { t } = useTranslation()
  switch (preview.kind) {
    case 'value':
      return (
        <strong>
          → {formatLiveValue(preview.value, true)}
          {preview.stale !== null ? ` (${preview.stale})` : ''}
        </strong>
      )
    case 'unavailable':
      return <span className="text-warning">{preview.reason}</span>
    case 'waiting':
      return (
        <span className="text-foreground-subtle">
          {t('compositionEditor.preview.waiting', { sources: preview.missing.join(', ') })}
        </span>
      )
    case 'runtime-only':
      return (
        <span className="text-foreground-subtle">{t('compositionEditor.preview.runtimeOnly')}</span>
      )
  }
}
