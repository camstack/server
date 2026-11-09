import type {
  BackdropKind,
  HeroSceneId,
  HeroSceneSpec,
  SceneSpeed,
  SceneTone,
  SceneVisual,
} from './types'

const OFF_STATES: ReadonlySet<string> = new Set(['off', 'idle', 'offline', 'standby', 'closed', ''])

function visual(
  kind: BackdropKind,
  tone: SceneTone,
  speed: SceneSpeed = 'normal',
  extra: Partial<SceneVisual> = {},
): SceneVisual {
  return { kind, tone, speed, dim: kind === 'none', ...extra }
}

const DIM: SceneVisual = visual('none', 'subtle')

/** No backdrop: the scene's own illustration moves (or is held still) in the tone. */
const still = (tone: SceneTone): SceneVisual => visual('none', tone, 'normal', { dim: false })

function resolveAc(state: string): SceneVisual {
  switch (state) {
    case 'cool':
      return visual('airflow', 'info', 'normal', { airflowMode: 'cool' })
    case 'heat':
      return visual('airflow', 'warning', 'normal', { airflowMode: 'heat' })
    case 'dry':
      return visual('airflow', 'info', 'slow', { airflowMode: 'dry' })
    case 'fan':
      return visual('airflow', 'muted', 'normal', { airflowMode: 'fan_only' })
    case 'auto':
      return visual('airflow', 'primary', 'normal', { airflowMode: 'auto' })
    default:
      return visual('airflow', 'subtle', 'slow', { airflowMode: 'off', dim: true })
  }
}

/** Scene id + state → the one background animation for that state. */
export function resolveSceneVisual(spec: HeroSceneSpec): SceneVisual {
  const state = spec.state ?? ''
  const on = !OFF_STATES.has(state)
  const resolved = resolveByScene(spec.scene, state, on)
  const speed = spec.speed ?? resolved.speed
  return { ...resolved, speed, tone: spec.tone ?? resolved.tone }
}

function resolveByScene(scene: HeroSceneId, state: string, on: boolean): SceneVisual {
  if (state === 'error' || state === 'fault' || state === 'jammed') {
    return visual('ripple', 'danger', 'fast')
  }
  switch (scene) {
    case 'ac':
      return resolveAc(state)
    case 'thermostat':
      if (state === 'heat') return visual('rise', 'warning')
      if (state === 'cool') return visual('fall', 'info')
      return DIM
    case 'heat-pump':
    case 'heater':
      return on ? visual('rise', 'warning') : DIM
    case 'fan':
      return on ? visual('fan', 'muted') : DIM
    case 'washer':
      if (state === 'done') return visual('breathe', 'success', 'slow')
      return on ? visual('drum', 'warning') : DIM
    case 'dryer':
      if (state === 'done') return visual('breathe', 'success', 'slow')
      return on ? visual('drum', 'warning') : DIM
    case 'dishwasher':
      if (state === 'done') return visual('breathe', 'success', 'slow')
      return on ? visual('drop', 'info') : DIM
    case 'pet-fountain':
      return on ? visual('ripple', 'info', 'slow') : DIM
    case 'pet-feeder':
      return on ? visual('drop', 'warning', 'slow') : DIM
    case 'vacuum':
      if (state === 'charging' || state === 'docked') return visual('breathe', 'success', 'slow')
      return on ? still('primary') : DIM
    case 'lawn-mower':
      if (state === 'returning') return visual('breathe', 'success', 'slow')
      return on ? still('success') : DIM
    case 'tv':
      return on ? visual('breathe', 'info') : DIM
    case 'speaker':
      return state === 'playing' ? visual('bars', 'primary') : DIM
    case 'camera':
      return state === 'recording' ? visual('ripple', 'danger', 'slow') : DIM
    case 'light':
      return on ? visual('breathe', 'warning', 'slow') : DIM
    case 'cover':
      return still(state === 'opening' || state === 'closing' ? 'info' : 'muted')
    case 'lock':
      if (state === 'locked') return visual('breathe', 'success', 'slow')
      return on ? visual('breathe', 'warning', 'slow') : DIM
    case 'alarm':
      if (state === 'triggered') return visual('ripple', 'danger', 'fast')
      return on ? visual('breathe', 'danger', 'slow') : DIM
    case 'siren':
      return state === 'sounding' ? visual('ripple', 'danger', 'fast') : DIM
    case 'sensor-sparkline':
      return visual('spark', 'info')
    case 'contact':
      return state === 'open' ? visual('breathe', 'warning', 'slow') : DIM
    case 'presence':
      return state === 'detected' ? visual('ripple', 'success') : DIM
    case 'weather':
      if (state === 'rain') return visual('drop', 'info')
      if (state === 'snow') return visual('fall', 'muted', 'slow')
      if (state === 'sun') return visual('breathe', 'warning', 'slow')
      return visual('breathe', 'info', 'slow')
    case 'plug':
      return on ? still('primary') : DIM
    case 'button':
      return state === 'pressed' ? visual('ripple', 'primary', 'fast') : DIM
    case 'update':
      if (state === 'installing') return visual('rise', 'primary', 'fast')
      return state === 'available' ? visual('rise', 'info', 'slow') : DIM
    case 'control-dial':
      return visual('breathe', 'primary', 'slow')
    case 'event-stream':
      return on ? visual('stream', 'info') : DIM
    case 'gateway':
      return state === 'offline' ? DIM : visual('orbit', 'info', 'slow')
    case 'generic':
      return on ? visual('breathe', 'muted', 'slow') : DIM
  }
}

export const TONE_CLASS: Readonly<Record<SceneTone, string>> = {
  primary: 'text-primary',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-foreground-muted',
  subtle: 'text-foreground-subtle',
}

/** A filled control in the scene's tone (a pressed segment): theme fill + its contrast colour. */
export const TONE_FILL: Readonly<Record<SceneTone, string>> = {
  primary: 'bg-primary-fill text-primary-on',
  info: 'bg-info-fill text-info-on',
  success: 'bg-success-fill text-success-on',
  warning: 'bg-warning-fill text-warning-on',
  danger: 'bg-danger-fill text-danger-on',
  muted: 'bg-neutral-fill text-neutral-on',
  subtle: 'bg-neutral-fill text-neutral-on',
}
