import { BAICHUAN_WEBHOOK_URL_GENERATION } from './baichuan-webhook-shared.js'

/** What the camera's HaCfg says now (`getHaCfg`), or `undefined` when the firmware has none. */
export interface ArmedHaCfg {
  readonly enable: boolean
  readonly url: string
}

export interface WebhookRepointPorts {
  /** The generation stored on this device, or undefined (the retired private listener). */
  readGeneration(): number | undefined
  /** Record that this device is on `generation`. */
  writeGeneration(generation: number): Promise<void>
  /** The camera's own HaCfg (the camera is awake: this runs right after a Baichuan login). */
  readCameraHaCfg(): Promise<ArmedHaCfg | undefined>
  /** The URL the camera must POST to now. Throws the reason when there is none. */
  targetUrl(): Promise<string>
  /** Arm the camera at `url`. */
  arm(url: string): Promise<void>
}

export type WebhookRepointOutcome =
  | 'current' // already on this generation: nothing read, nothing written
  | 'not-armed' // the camera never had a webhook: nothing to move
  | 'already-there' // armed at the right URL
  | 'repointed'

/**
 * Point a battery camera's webhook at the data-plane URL ONCE per URL generation.
 *
 * Runs on a camera's first Baichuan contact after the upgrade (the one moment it is awake without
 * us waking it). Only a camera that is actually armed is moved: reading its HaCfg decides, so a
 * camera on e-mail push is never switched to the webhook by an upgrade. The generation is written
 * only when the camera was moved or found not to need moving; a failure (no internal address, the
 * camera refusing the write) leaves it unwritten, so the next contact tries again.
 */
export async function repointWebhookOnce(
  ports: WebhookRepointPorts,
): Promise<WebhookRepointOutcome> {
  const stored = ports.readGeneration()
  if (stored !== undefined && stored >= BAICHUAN_WEBHOOK_URL_GENERATION) return 'current'
  const armed = await ports.readCameraHaCfg()
  if (armed === undefined || !armed.enable || armed.url.length === 0) {
    await ports.writeGeneration(BAICHUAN_WEBHOOK_URL_GENERATION)
    return 'not-armed'
  }
  const url = await ports.targetUrl()
  if (armed.url === url) {
    await ports.writeGeneration(BAICHUAN_WEBHOOK_URL_GENERATION)
    return 'already-there'
  }
  await ports.arm(url)
  await ports.writeGeneration(BAICHUAN_WEBHOOK_URL_GENERATION)
  return 'repointed'
}
