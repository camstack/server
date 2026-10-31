/**
 * Per-node inference-device picker: the single-select chip row the run
 * target uses, and the friendly name of a probed device. The multi-select it
 * shared this file with fanned the removed Sustained Throughput tab out per
 * device (D646) and went with it.
 */
import { useT } from '../i18n/index.js'
import { Button } from '@camstack/ui-library'

export interface DeviceOption {
  readonly key: string
  readonly label: string
  /** Live-probe reports the device usable right now. */
  readonly available: boolean
  /** Operator opt-in from the node's stored inferenceDevices map. */
  readonly enabled: boolean
}

/** Friendly accelerator name for a probed inference device. */
export function friendlyDeviceName(d: {
  readonly backend: string
  readonly device: string
  readonly format: string
}): string {
  const device = d.device.toLowerCase()
  const backend = d.backend.toLowerCase()
  if (device === 'npu') return 'NPU'
  if (device === 'gpu' || device === 'igpu') return 'iGPU'
  if (backend === 'edgetpu' || d.format === 'tflite') return 'Coral'
  if (backend === 'cpu' || device === 'cpu') return 'CPU'
  return `${d.backend}:${d.device}`
}

/**
 * Single-accelerator picker — the Detection Pipeline tab runs ONE
 * `(node, deviceKey)` pair at a time, unlike the sustained bench which fans
 * one target out per selected device.
 *
 * `null` is meaningful and is not the same as "the first device": it emits a
 * run with NO `deviceKey`, which the executing node answers on its default
 * pool. An operator asking "why is 102 worse than 101" needs to be able to
 * say "on the device it really uses" AND "on whatever this node picks".
 */
interface SingleDeviceSelectorProps {
  readonly value: string | null
  readonly onChange: (next: string | null) => void
  readonly devices: readonly DeviceOption[]
  readonly disabled?: boolean
  /** Marked with a dot: the accelerator the selected camera is LIVE on. */
  readonly liveKey?: string | undefined
}

export function SingleDeviceSelector({
  value,
  onChange,
  devices,
  disabled,
  liveKey,
}: SingleDeviceSelectorProps) {
  const { t } = useT()
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-foreground-subtle">{t('device.label')}</span>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="unstyled"
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          title={t('device.nodeDefaultTitle')}
          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
            value === null
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-surface text-foreground border-border hover:border-primary/50'
          } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          {t('common.nodeDefault')}
        </Button>
        {devices.map((d) => (
          <Button
            variant="unstyled"
            key={d.key}
            type="button"
            disabled={disabled || !d.available}
            onClick={() => onChange(d.key)}
            title={d.key}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
              value === d.key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-surface text-foreground border-border hover:border-primary/50'
            } ${d.available && !disabled ? '' : 'opacity-40 cursor-not-allowed'}`}
          >
            <span className="flex items-center gap-1.5">
              {d.key === liveKey && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-success"
                  title={t('device.liveForCamera')}
                />
              )}
              {d.label}
            </span>
          </Button>
        ))}
      </div>
      {devices.length === 0 && (
        <span className="text-xs text-foreground-subtle/60">{t('device.noAccelerators')}</span>
      )}
    </div>
  )
}
