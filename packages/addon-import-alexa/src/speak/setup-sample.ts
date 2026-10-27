import type { EchoDevice } from './worker-protocol.js'
import type { SetupPhase } from './setup-flow.js'

/** Invented devices for the screenshot harness. Not a real account. */
export const SAMPLE_ECHOES: readonly EchoDevice[] = [
  {
    id: 'echo-kitchen',
    name: 'Kitchen',
    family: 'ECHO',
    online: true,
    kind: 'device',
    dnd: false,
    deviceType: 'A3S5BH2HU6VAYF',
  },
  {
    id: 'echo-hall',
    name: 'Hall',
    family: 'ECHO',
    online: true,
    kind: 'device',
    dnd: true,
    deviceType: 'A3S5BH2HU6VAYF',
  },
  {
    id: 'group-downstairs',
    name: 'Downstairs',
    family: 'WHA',
    online: true,
    kind: 'group',
    dnd: false,
    deviceType: 'A3S5BH2HU6VAYF',
  },
]

export function shotStep(): SetupPhase | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('ui-shots-step')
  if (raw === 'sign-in' || raw === 'otp' || raw === 'captcha' || raw === 'devices') return raw
  return null
}
