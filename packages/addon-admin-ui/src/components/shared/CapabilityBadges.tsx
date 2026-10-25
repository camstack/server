import {
  Video,
  Eye,
  CircleDot,
  Mic,
  Camera,
  Zap,
  Shield,
  Cpu,
  Radio,
  Settings,
  Box,
  BatteryFull,
  Bell,
  RefreshCw,
  Map,
  Sparkles,
  Grid2x2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Capability registry. Keys can be free-form badge ids (`'streaming'`,
 * `'detection'` etc.) OR canonical `DeviceFeature` enum values
 * (`'battery-operated'`, `'pan-tilt-zoom'`, …) so callers can pass
 * `device.features` straight through without an adapter step.
 */
const CAPABILITY_INFO: Record<string, { icon: LucideIcon; labelKey: string }> = {
  streaming: { icon: Video, labelKey: 'capabilityBadges.streaming' },
  detection: { icon: Eye, labelKey: 'capabilityBadges.detection' },
  recording: { icon: CircleDot, labelKey: 'capabilityBadges.recording' },
  audio: { icon: Mic, labelKey: 'capabilityBadges.audio' },
  snapshot: { icon: Camera, labelKey: 'capabilityBadges.snapshot' },
  motion: { icon: Zap, labelKey: 'capabilityBadges.motion' },
  ptz: { icon: Settings, labelKey: 'capabilityBadges.ptz' },
  webrtc: { icon: Radio, labelKey: 'capabilityBadges.webrtc' },
  onvif: { icon: Shield, labelKey: 'capabilityBadges.onvif' },
  analytics: { icon: Cpu, labelKey: 'capabilityBadges.analytics' },
  // Canonical DeviceFeature values
  'battery-operated': { icon: BatteryFull, labelKey: 'capabilityBadges.battery' },
  'native-snapshot': { icon: Camera, labelKey: 'capabilityBadges.nativeSnapshot' },
  'pan-tilt-zoom': { icon: Settings, labelKey: 'capabilityBadges.ptz' },
  'two-way-audio': { icon: Mic, labelKey: 'capabilityBadges.twoWayAudio' },
  'doorbell-button': { icon: Bell, labelKey: 'capabilityBadges.doorbell' },
  rebootable: { icon: RefreshCw, labelKey: 'capabilityBadges.rebootable' },
  // Vacuum / mower container features (Dreame): friendly label + icon so the
  // canonical DeviceFeature value renders as a labelled badge rather than the
  // generic box + raw kebab string.
  'vacuum-has-map': { icon: Map, labelKey: 'capabilityBadges.map' },
  'vacuum-has-ai': { icon: Sparkles, labelKey: 'capabilityBadges.aiObstacle' },
  'mower-has-map': { icon: Map, labelKey: 'capabilityBadges.map' },
  'mower-has-targeted-mowing': { icon: Grid2x2, labelKey: 'capabilityBadges.targetedMowing' },
}

const DEFAULT_ICON = Box

interface CapabilityBadgesProps {
  readonly capabilities: readonly string[]
  readonly showLabels?: boolean
}

export function CapabilityBadges({ capabilities, showLabels = false }: CapabilityBadgesProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {capabilities.map((cap) => {
        const info = CAPABILITY_INFO[cap]
        const Icon = info?.icon ?? DEFAULT_ICON
        const label = info ? t(info.labelKey) : cap
        return (
          <span
            key={cap}
            className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-subtle"
            title={label}
          >
            <Icon className="h-3 w-3" />
            {showLabels && <span>{label}</span>}
          </span>
        )
      })}
    </div>
  )
}
