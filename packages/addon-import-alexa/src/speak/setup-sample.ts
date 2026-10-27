import type { SpeakStatus } from './actions.js'
import type { EchoDevice } from './worker-protocol.js'

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
    room: 'Ground floor',
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

const SESSION = { loggedIn: true, ageSec: 90, lastSuccessAt: 1 } as const
const NO_SESSION = { loggedIn: false, ageSec: 0, lastSuccessAt: null } as const

export type ShotStep = 'ready' | 'accounts' | 'waiting' | 'legacy'

/** The status each harness step shows. */
export function sampleStatus(step: ShotStep): SpeakStatus {
  const home = {
    id: 'alexa_001',
    name: 'Home',
    state: 'ready',
    devices: [...SAMPLE_ECHOES],
    session: SESSION,
  } as const
  if (step === 'waiting') {
    return {
      brokers: [{ ...home, state: 'broker-not-signed-in', devices: [], session: NO_SESSION }],
      unassignedTargets: 0,
      notice: '',
    }
  }
  if (step === 'accounts') {
    return {
      brokers: [
        home,
        { ...home, id: 'alexa_002', name: 'Office', devices: [SAMPLE_ECHOES[0]!] },
      ].map((row) => ({ ...row, devices: [...row.devices] })),
      unassignedTargets: 0,
      notice: '',
    }
  }
  if (step === 'legacy') {
    return {
      brokers: [home, { ...home, id: 'alexa_002', name: 'Office', devices: [] }].map((row) => ({
        ...row,
        devices: [...row.devices],
      })),
      unassignedTargets: 2,
      notice: 'choose-broker',
    }
  }
  return { brokers: [{ ...home, devices: [...home.devices] }], unassignedTargets: 0, notice: '' }
}

export function shotStep(): ShotStep | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('ui-shots-step')
  if (raw === 'ready' || raw === 'accounts' || raw === 'waiting' || raw === 'legacy') return raw
  return null
}
