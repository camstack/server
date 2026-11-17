/**
 * What a purifier speed request sends, decided from the last known state. Pure: the device layer
 * runs the steps through one `runCommand` (one log line, one refresh after the last step).
 */
import type { VeSyncClient, VeSyncPurifierSnapshot } from './vesync-client-contract.js'

/** The mode a speed level applies in; every other mode is a preset that drives the fan itself. */
export const VESYNC_MANUAL_MODE = 'manual'

/** One call a speed request makes. */
export type PurifierSpeedStep =
  | { readonly kind: 'power'; readonly on: boolean }
  | { readonly kind: 'mode'; readonly mode: string }
  | { readonly kind: 'speed'; readonly percent: number }

/**
 * The calls a speed request makes. Zero turns the purifier off. Otherwise it powers on when off,
 * switches a preset (Auto, Sleep …) to Manual — operator decision: the slider means "this speed",
 * and VeSync ignores a speed while a preset runs — and then sets the speed. An unknown state
 * (no snapshot yet) sends the speed alone.
 */
export function planPurifierSpeed(
  purifier: VeSyncPurifierSnapshot | null,
  percent: number,
): readonly PurifierSpeedStep[] {
  if (percent <= 0) return [{ kind: 'power', on: false }]
  const steps: PurifierSpeedStep[] = []
  if (purifier !== null && !purifier.power) steps.push({ kind: 'power', on: true })
  if (purifier !== null && purifier.preset !== '') {
    steps.push({ kind: 'mode', mode: VESYNC_MANUAL_MODE })
  }
  steps.push({ kind: 'speed', percent })
  return steps
}

/** The steps as one log name: `setPower(on)+setMode(manual)+setFanSpeed(67)`. */
export function describeSpeedSteps(steps: readonly PurifierSpeedStep[]): string {
  return steps
    .map((step) => {
      if (step.kind === 'power') return `setPower(${step.on ? 'on' : 'off'})`
      if (step.kind === 'mode') return `setMode(${step.mode})`
      return `setFanSpeed(${step.percent})`
    })
    .join('+')
}

/** Send the steps in order; the first refusal stops the rest. */
export async function runSpeedSteps(
  client: VeSyncClient,
  nativeId: string,
  steps: readonly PurifierSpeedStep[],
): Promise<void> {
  for (const step of steps) {
    if (step.kind === 'power') await client.setPower(nativeId, step.on)
    else if (step.kind === 'mode') await client.setMode(nativeId, step.mode)
    else await client.setFanSpeed(nativeId, step.percent)
  }
}
