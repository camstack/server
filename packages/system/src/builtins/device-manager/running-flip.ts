export interface RunningFlipEvent {
  readonly kind: 'started' | 'finished'
  readonly deviceId: number
  readonly since: number | null
  readonly phase: string | null
}

type Memory = boolean | null | undefined

function readRunning(slice: Record<string, unknown>): boolean | null {
  const running = slice['running']
  if (running === true || running === false) return running
  return null
}

export class RunningFlipDetector {
  readonly #memory = new Map<number, Memory>()

  seed(deviceId: number, running: boolean | null): void {
    this.#memory.set(deviceId, running)
  }

  note(deviceId: number, slice: Record<string, unknown>): RunningFlipEvent | null {
    const running = readRunning(slice)
    const since =
      typeof slice['since'] === 'number' && Number.isFinite(slice['since']) ? slice['since'] : null
    const phase = typeof slice['phase'] === 'string' ? slice['phase'] : null
    const prev = this.#memory.get(deviceId)
    this.#memory.set(deviceId, running)

    if (prev === undefined) {
      if (running === true) {
        return { kind: 'started', deviceId, since, phase }
      }
      return null
    }
    if (prev === true && running === false) {
      return { kind: 'finished', deviceId, since, phase }
    }
    if (prev !== true && running === true) {
      return { kind: 'started', deviceId, since, phase }
    }
    return null
  }
}
