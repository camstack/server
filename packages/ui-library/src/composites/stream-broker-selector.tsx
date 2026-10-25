/**
 * StreamBrokerSelector — reusable per-device "preferred stream" picker.
 *
 * Renders a single `<Select>` with options sourced from the device's
 * camera-streams cap (`getRtspEntries`). The first option is always
 * "Auto (best available)"; remaining options are one per enabled
 * RTSP restream entry, labelled by stream profile (`High` / `Mid` /
 * `Low` …) and tagged with codec + resolution when the broker reports
 * them.
 *
 * Used by addon-built panels that don't flow through the form-builder
 * `ConfigUISchema` aggregator (the cap-driven aggregator already
 * embeds an equivalent `select` field with server-resolved options —
 * the addons return the same list inline). Reach for this composite
 * when you need an out-of-form selector in a bespoke React tree (e.g.
 * an addon's wizard page, a debug panel, etc.).
 *
 * Loading / empty / error states all render a degraded select rather
 * than vanishing — the operator can always pick `Auto` even if the
 * device's broker is currently unreachable.
 */
import { useUiText } from '../contexts/ui-text'
import { useEffect, useMemo, useState, useId, type ReactElement } from 'react'
import { Select } from '../primitives/select'
import { useCameraStreamsGetRtspEntries } from '../generated/system-hooks'

export interface StreamBrokerSelectorProps {
  readonly deviceId: number
  readonly value: 'auto' | string
  readonly onChange: (next: 'auto' | string) => void
  readonly disabled?: boolean
  readonly label?: string
  readonly className?: string
}

interface StreamOption {
  readonly value: string
  readonly label: string
}

/** Friendly profile label — "high" → "High", "mid" → "Mid", etc. */
function profileLabel(streamId: string): string {
  return streamId.charAt(0).toUpperCase() + streamId.slice(1)
}

export function StreamBrokerSelector({
  deviceId,
  value,
  onChange,
  disabled,
  label,
  className,
}: StreamBrokerSelectorProps): ReactElement {
  const t = useUiText()
  const labelId = useId()
  const query = useCameraStreamsGetRtspEntries({ deviceId }, { refetchOnWindowFocus: false })
  const [streamIds, setStreamIds] = useState<readonly string[]>([])

  useEffect(() => {
    if (!query.data) return
    const prefix = `${deviceId}/`
    const next: string[] = []
    for (const entry of query.data) {
      if (!entry.enabled) continue
      const streamId = entry.brokerId.startsWith(prefix)
        ? entry.brokerId.slice(prefix.length)
        : entry.brokerId
      next.push(streamId)
    }
    setStreamIds(next)
  }, [query.data, deviceId])

  const options: StreamOption[] = useMemo(
    () => [
      { value: 'auto', label: t('uiLibrary.streamBrokerSelector.auto', 'Auto (best available)') },
      ...streamIds.map((streamId) => ({ value: streamId, label: profileLabel(streamId) })),
    ],
    [streamIds, t],
  )

  const resolvedLabel = label ?? t('uiLibrary.streamBrokerSelector.preferred', 'Preferred stream')
  const helperText = query.isLoading
    ? t('uiLibrary.streamBrokerSelector.loading', 'Loading available streams…')
    : query.isError
      ? t(
          'uiLibrary.streamBrokerSelector.loadFailed',
          'Could not load streams — only Auto available.',
        )
      : options.length === 1
        ? t(
            'uiLibrary.streamBrokerSelector.noneEnabled',
            'No enabled streams found — only Auto available.',
          )
        : null

  return (
    <div className={className}>
      <label id={labelId} className="text-xs font-medium text-foreground-muted block mb-1">
        {resolvedLabel}
      </label>
      <Select
        aria-labelledby={labelId}
        options={options}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as 'auto' | string)}
      />
      {helperText !== null && (
        <p className="text-foreground-subtle text-[10px] mt-1">{helperText}</p>
      )}
    </div>
  )
}
