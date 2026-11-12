/**
 * Coalesce completed addon package updates into one notification.
 *
 * `addon.updated` fires once per addon in a package (a pipeline package
 * declares six) and once per package in a bulk job. The operator asked for
 * "N addons updated", not N×M pushes. Each observation resets a 30 s timer;
 * the flush carries every distinct package seen in the window.
 *
 * Settings-level `addon.updated` events (no `toVersion`) are the caller's
 * problem — this class never sees them.
 */

import { WindowCoalescer } from './window-coalescer.js'

export const ADDON_UPDATE_COALESCE_MS = 30_000

export interface AddonUpdateComplete {
  readonly packageName: string
  /**
   * The version that was running before, when the emitter could read it.
   *
   * OPTIONAL because it is genuinely unknowable on a first install and on a
   * tree the hub cannot read back, and the emitter now omits it rather than
   * filling in `'0.0.0'` — a placeholder shaped like a version is one the
   * operator cannot tell from a real one. `toVersion` stays REQUIRED: it is
   * what separates a package update from a settings save, which emits the
   * same category carrying neither.
   */
  readonly fromVersion?: string
  readonly toVersion: string
  readonly nodeId?: string
}

export interface AddonUpdateCoalescerOptions {
  readonly delayMs?: number
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly cancel?: (id: ReturnType<typeof setTimeout>) => void
}

export class AddonUpdateCoalescer {
  private readonly window: WindowCoalescer<AddonUpdateComplete>

  constructor(
    flush: (updates: readonly AddonUpdateComplete[]) => void,
    options: AddonUpdateCoalescerOptions = {},
  ) {
    this.window = new WindowCoalescer<AddonUpdateComplete>({
      mode: 'sliding',
      delayMs: options.delayMs ?? ADDON_UPDATE_COALESCE_MS,
      identityOf: (update) => update.packageName,
      onFlush: (_key, updates) => {
        flush(updates)
      },
      ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
      ...(options.cancel !== undefined ? { cancel: options.cancel } : {}),
    })
  }

  observe(update: AddonUpdateComplete): void {
    this.window.observe('addon-updates', update)
  }

  dispose(): void {
    this.window.dispose()
  }
}
