import { CircleCheck, CircleX, CircleAlert, CircleHelp, type LucideIcon } from 'lucide-react'

export type StatusType = 'online' | 'offline' | 'degraded' | 'unknown'

export const statusIcons: Record<StatusType, LucideIcon> = {
  online: CircleCheck,
  offline: CircleX,
  degraded: CircleAlert,
  unknown: CircleHelp,
}
