import {
  WorkloadStateSchema,
  isWorkloadSettled,
  workloadTransition,
  type WorkloadSettledState,
  type WorkloadState,
  type WorkloadTransitionKind,
} from '@camstack/types'

/** One workload event the mirror emits (#585). */
export interface WorkloadTransitionEvent {
  readonly kind: WorkloadTransitionKind
  readonly deviceId: number
  readonly state: WorkloadState
  readonly previous: WorkloadSettledState
  readonly since: number | null
}

function readState(slice: Readonly<Record<string, unknown>>): WorkloadState | null {
  const parsed = WorkloadStateSchema.safeParse(slice['state'])
  return parsed.success ? parsed.data : null
}

/**
 * Remembers each workload's last SETTLED state (running, paused, stopped,
 * crashed) and turns a move away from it into the cap's events. `starting` /
 * `stopping` and an unknown state are never remembered, so stopped → starting →
 * running is one `started`, and crashed → starting → running one `recovered`.
 *
 * The first state seen for a device is a seed: it raises nothing, so a hub
 * restart does not announce every running container as started.
 */
export class WorkloadTransitionDetector {
  readonly #settled = new Map<number, WorkloadSettledState>()

  note(deviceId: number, slice: Readonly<Record<string, unknown>>): WorkloadTransitionEvent | null {
    const state = readState(slice)
    const previous = this.#settled.get(deviceId)
    const kind = workloadTransition(previous, state)
    if (state !== null && isWorkloadSettled(state)) this.#settled.set(deviceId, state)
    if (kind === null || state === null || previous === undefined) return null
    const since =
      typeof slice['since'] === 'number' && Number.isFinite(slice['since']) ? slice['since'] : null
    return { kind, deviceId, state, previous, since }
  }

  forget(deviceId: number): void {
    this.#settled.delete(deviceId)
  }
}
