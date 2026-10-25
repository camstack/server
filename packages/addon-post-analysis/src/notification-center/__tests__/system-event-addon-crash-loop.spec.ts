/**
 * `addon.runner-failed` → the `addon-crash-loop` notification kind.
 *
 * The 2026-08-18 outage in one sentence: the D6 crash circuit-breaker did
 * exactly what it should (stopped respawning a runner that had crashed five
 * times in nine seconds) and told NOBODY. `/health` stayed 200 for the three
 * hours and fifteen minutes the fleet spent not recording.
 *
 * Three things are pinned here, because each of them has been the missing link
 * in a starved notification kind before:
 *   1. the intake TRANSLATES the bus category into the kind,
 *   2. the wiring SUBSCRIBES to that category (an intake case for a category
 *      nobody subscribes to is a kind that can never fire), and
 *   3. the catalog RESOLVES both keys in every shipped language (a missing key
 *      renders an empty notification).
 */
import { createEvent, EventCategory, type SystemEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_SYSTEM_EVENT_CATEGORIES } from '../../pipeline-analytics/runtime/wire-subscriptions.js'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NC_LANGUAGES, NcTextCatalog } from '../text-catalog.js'

/** No device is involved — a runner is not a camera. */
const NO_DEVICES: NcDeviceLookup = () => undefined

const RUNNER_FAILED = createEvent(
  'addon.runner-failed',
  { type: 'core', id: 'recorder' },
  {
    runnerId: 'recorder',
    nodeId: 'hub',
    addonIds: ['recorder'],
    crashesInWindow: 5,
    windowMs: 60_000,
    exitCode: 1,
  },
)

describe('a runner the crash circuit-breaker gave up on', () => {
  it('becomes an addon-crash-loop system event, scoped to its node', () => {
    const incoming = incomingFromSystemEvent(RUNNER_FAILED, NO_DEVICES)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'addon-crash-loop',
      // Its OWN subject family: a runner that will not come back is not the
      // same fact as the node going away, and sharing a dedup slot would let
      // one suppress the other.
      subject: 'addon-crash:hub:recorder',
      titleKey: 'system.addon-crash-loop.title',
      bodyKey: 'system.addon-crash-loop.body',
      textParams: { nodeId: 'hub', addons: 'recorder', count: '5' },
      nodeId: 'hub',
    })
    // No device: the rule engine must not be handed one it cannot justify.
    expect(incoming?.subject.systemEvent?.deviceId).toBeUndefined()
  })

  it('refuses a payload that cannot name the runner rather than guessing', () => {
    const malformed: SystemEvent = {
      ...RUNNER_FAILED,
      data: {
        nodeId: 'hub',
        addonIds: ['recorder'],
        crashesInWindow: 5,
        windowMs: 60_000,
      },
    }
    expect(incomingFromSystemEvent(malformed, NO_DEVICES)).toBeNull()
  })

  it('is a category the Notification Center actually subscribes to', () => {
    expect(NC_SYSTEM_EVENT_CATEGORIES).toContain(EventCategory.AddonRunnerFailed)
  })

  it('resolves a real sentence in every shipped language', () => {
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const vars = { nodeId: 'hub', addons: 'recorder', count: '5' }
      const title = catalog.text({ key: 'system.addon-crash-loop.title', vars })
      const body = catalog.text({ key: 'system.addon-crash-loop.body', vars })
      expect(title.length).toBeGreaterThan(0)
      expect(body).toContain('recorder')
      expect(body).toContain('hub')
      expect(body).not.toContain('{{')
    }
  })
})
