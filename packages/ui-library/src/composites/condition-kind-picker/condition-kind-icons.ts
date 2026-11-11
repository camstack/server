import type { AutomationLeafKind } from '@camstack/types'
import {
  Activity,
  Bell,
  CalendarClock,
  Clock,
  Car,
  Eye,
  Hand,
  ParkingSquare,
  Sigma,
  Split,
  Timer,
  ToggleLeft,
  type LucideIcon,
} from 'lucide-react'

/** One icon per row kind. Total by its type: a new kind without an icon does not compile. */
export const CONDITION_KIND_ICONS: Readonly<Record<AutomationLeafKind, LucideIcon>> = {
  detection: Eye,
  stationary: ParkingSquare,
  'device-becomes': Activity,
  'device-event': Bell,
  schedule: CalendarClock,
  interval: Timer,
  manual: Hand,
  'device-is': ToggleLeft,
  'stationary-present': Car,
  'time-is': Clock,
  'triggered-by': Split,
  expression: Sigma,
}
