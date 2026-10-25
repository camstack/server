/**
 * The device-compatibility guard FAILS OPEN when its capability read is not
 * wired (D49) — which means a dropped wiring line in `pipeline-analytics`
 * would turn the guard off in production with the suite still green, because
 * every unit test injects the read itself.
 *
 * So this boots the REAL addon and drives the REAL providers it registers:
 * the cap-provider route (`notificationRules.createRule`) and the rule bridge
 * (`nc.createRule`). Both must refuse a detection rule naming a device the
 * fleet says cannot run detection — which they can only do if
 * `deviceManager.listDeviceIdsByCaps` reached the guard through the addon's
 * own wiring.
 */
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { NcDeviceCompatRefusal } from '../../notification-center/device-compat-guard.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'

/** Camera 101 runs detection; lock 42 does not. */
const FLEET = async (capNames: readonly string[]): Promise<readonly number[]> =>
  capNames.includes('detection-pipeline') ? [101] : [42]

const LOCKED_RULE = NcRuleInputSchema.parse({
  name: 'Vialetto',
  delivery: 'immediate',
  conditions: { devices: [101, 42] },
  targets: [{ targetId: 'target-1' }],
})

interface RuleCreator {
  readonly createRule: (input: {
    readonly rule: typeof LOCKED_RULE
    readonly caller: { readonly userId: string; readonly isAdmin: boolean }
  }) => Promise<unknown>
}

function isRuleCreator(provider: object): provider is RuleCreator {
  return 'createRule' in provider && typeof provider.createRule === 'function'
}

function rulesProvider(booted: Booted): RuleCreator {
  const registration = booted.init?.providers?.find(
    (entry) => entry.capability.name === 'notification-rules',
  )
  if (registration === undefined || !isRuleCreator(registration.provider)) {
    throw new Error('notification-rules provider not registered')
  }
  return registration.provider
}

const booted: Booted[] = []
afterEach(async () => {
  await Promise.all(booted.splice(0).map((b) => b.addon.shutdown()))
})

describe('the device-compat guard is WIRED on both save routes', () => {
  it('notificationRules.createRule refuses an incompatible device — the read reached the guard', async () => {
    const b = await bootAnalytics(101, async () => null, { listDeviceIdsByCaps: FLEET })
    booted.push(b)
    await expect(
      rulesProvider(b).createRule({
        rule: LOCKED_RULE,
        caller: { userId: 'admin', isAdmin: true },
      }),
    ).rejects.toThrow(NcDeviceCompatRefusal)
  }, 20_000)

  it('nc.createRule refuses it too', async () => {
    const b = await bootAnalytics(101, async () => null, { listDeviceIdsByCaps: FLEET })
    booted.push(b)
    const handler = b.init?.actionHandlers?.['nc.createRule']
    expect(handler).toBeDefined()
    await expect(
      handler?.({ rule: LOCKED_RULE }, { userId: 'admin', isAdmin: true }),
    ).rejects.toThrow(NcDeviceCompatRefusal)
  }, 20_000)
})
