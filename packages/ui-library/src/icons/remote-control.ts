import { createLucideIcon, type LucideIcon } from 'lucide-react'

/** Handset remote control: body, a round top button and a 2x2 key pad. */
export const RemoteControl: LucideIcon = createLucideIcon('RemoteControl', [
  ['rect', { x: '7', y: '2', width: '10', height: '20', rx: '3', key: 'body' }],
  ['circle', { cx: '12', cy: '8', r: '2.5', key: 'top' }],
  ['path', { d: 'M10 14h.01', key: 'k1' }],
  ['path', { d: 'M14 14h.01', key: 'k2' }],
  ['path', { d: 'M10 18h.01', key: 'k3' }],
  ['path', { d: 'M14 18h.01', key: 'k4' }],
])
