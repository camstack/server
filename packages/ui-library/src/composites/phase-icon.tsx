/**
 * PhaseIcon — renders the correct lucide icon for a CameraPhase.
 *
 * Wraps the PHASE_CONFIG icon name → component resolution so consumers
 * don't need to maintain their own icon switch/map.
 */
import { Activity, Eye, AlertTriangle, PauseCircle, PowerOff, type LucideProps } from 'lucide-react'
import { getPhaseVisual } from '../lib/phase-config'
import { type JSX } from 'react'

const ICON_MAP = {
  Activity,
  Eye,
  AlertTriangle,
  PauseCircle,
  PowerOff,
} as const

export interface PhaseIconProps extends LucideProps {
  readonly phase: string
}

export function PhaseIcon({ phase, ...props }: PhaseIconProps): JSX.Element {
  const cfg = getPhaseVisual(phase)
  const Icon = ICON_MAP[cfg.icon]
  return <Icon {...props} />
}
