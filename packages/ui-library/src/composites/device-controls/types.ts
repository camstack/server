import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'

/** Shared props for every control panel. `layout` selects the compact (row
 *  popover) vs full (detail tab) presentation. `features` gates sub-controls
 *  (e.g. cover position/tilt, fan speed/preset). */
export interface ControlPanelProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly features: readonly string[] | undefined
  readonly layout: 'compact' | 'full'
  /** Enable optimistic UI mode (default: true). Set to false to disable. */
  readonly optimistic?: boolean
}

/** Cap names whose presence (bound on a device) means it has a control surface.
 *  Single source of truth shared by the row registry and the detail Controls tab
 *  so the two never drift. */
export const CONTROL_CAP_NAMES = [
  'cover',
  'lock-control',
  'switch',
  'brightness',
  'fan-control',
  'climate-control',
  'media-player',
  'control',
  'pet-feeder',
  'pet-fountain',
  'dishwasher',
] as const

export type ControlCapName = (typeof CONTROL_CAP_NAMES)[number]
