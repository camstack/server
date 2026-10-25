/**
 * The hub-core API is reachable on the mesh BEFORE a single addon boots.
 *
 * The measured failure (docs/design/boot-to-usable-camera.md, D167 item 1):
 * `core-blocks.onInitialize()` awaited `integrations.getByAddonId`, a hub-CORE
 * namespace served by `$core-caps` — which `main.ts` registered only after
 * `app.init()` returned, and `app.init()` is where the entire addon boot runs.
 * The call polled the full 30 s discovery deadline and fast-failed. It sat on
 * the serial in-process builtin chain in front of `device-manager`, and every
 * provider runner blocks on `awaitReady('device-manager')` before publishing a
 * capability — so one optional feature held the whole cluster's capability
 * graph, and the first camera's first keyframe landed at t0+75 s.
 *
 * `beforeAddonBoot` is where that registration now happens. These gates fail
 * when the hook is moved back after the addon boot, or dropped.
 */
import { describe, expect, it, vi } from 'vitest'
import { runBootInitSequence } from '../init-sequence.js'

describe('runBootInitSequence', () => {
  it('runs beforeAddonBoot AFTER the broker and BEFORE any addon boots', async () => {
    const order: string[] = []
    const step = (name: string) => async () => {
      await Promise.resolve()
      order.push(name)
    }

    await runBootInitSequence({
      moleculer: step('moleculer'),
      addonBridge: step('addon-bridge'),
      agentRegistry: step('agent-registry'),
      beforeAddonBoot: step('core-caps'),
      addonBoot: step('addon-boot'),
      afterAddonBoot: step('after'),
    })

    expect(order).toEqual([
      'moleculer',
      'addon-bridge',
      'agent-registry',
      'core-caps',
      'addon-boot',
      'after',
    ])
  })

  it('AWAITS beforeAddonBoot — a half-registered bridge is the bug it fixes', async () => {
    const order: string[] = []
    let released = false

    await runBootInitSequence({
      moleculer: () => {},
      addonBridge: () => {},
      agentRegistry: () => {},
      beforeAddonBoot: async () => {
        await new Promise((r) => setTimeout(r, 10))
        released = true
        order.push('core-caps')
      },
      addonBoot: () => {
        // If the hook were fired-and-forgotten, addon boot would start with the
        // mesh bridge still absent — exactly the 30 s window this removes.
        expect(released).toBe(true)
        order.push('addon-boot')
      },
    })

    expect(order).toEqual(['core-caps', 'addon-boot'])
  })

  it('does not swallow a beforeAddonBoot failure — the caller owns that decision', async () => {
    const addonBoot = vi.fn()

    await expect(
      runBootInitSequence({
        moleculer: () => {},
        addonBridge: () => {},
        agentRegistry: () => {},
        beforeAddonBoot: () => {
          throw new Error('core-cap bridge failed')
        },
        addonBoot,
      }),
    ).rejects.toThrow('core-cap bridge failed')

    expect(addonBoot).not.toHaveBeenCalled()
  })

  it('is optional — a boot with no hook keeps the original order', async () => {
    const order: string[] = []
    await runBootInitSequence({
      moleculer: () => {
        order.push('moleculer')
      },
      addonBridge: () => {
        order.push('addon-bridge')
      },
      agentRegistry: () => {
        order.push('agent-registry')
      },
      addonBoot: () => {
        order.push('addon-boot')
      },
    })
    expect(order).toEqual(['moleculer', 'addon-bridge', 'agent-registry', 'addon-boot'])
  })
})
