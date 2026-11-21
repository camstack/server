import type { AutomationLeafKind } from '@camstack/types'
import {
  Activity,
  Bell,
  CalendarClock,
  Clock,
  Car,
  Eye,
  Hand,
  MousePointerClick,
  OctagonAlert,
  ParkingSquare,
  Sigma,
  Split,
  Timer,
  ToggleLeft,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'

/** One icon per row kind. Total by its type: a new kind without an icon does not compile. */
export const CONDITION_KIND_ICONS: Readonly<Record<AutomationLeafKind, LucideIcon>> = {
  detection: Eye,
  stationary: ParkingSquare,
  'device-becomes': Activity,
  'device-event': Bell,
  'device-fired': MousePointerClick,
  'device-fault-raised': TriangleAlert,
  'device-fault-is': OctagonAlert,
  schedule: CalendarClock,
  interval: Timer,
  manual: Hand,
  'device-is': ToggleLeft,
  'stationary-present': Car,
  'time-is': Clock,
  'triggered-by': Split,
  expression: Sigma,
}
