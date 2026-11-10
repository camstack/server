/**
 * An Action that presses `alarm-panel.trigger` carries the rule fire that started
 * it (D705). The same press with no fire, while the arm excludes a sensor, is
 * refused (D735). A press with no command origin at all is a person's.
 */

import { commandOrigin } from '@camstack/types'
import { runWithCapCallContext } from '@camstack/server/system'
import { afterEach, describe, expect, it } from 'vitest'
import type { NcAlarmPublishReport } from '../alarm-panel-device.js'
import { NcAlarmPanelDevice } from '../alarm-panel-device.js'
import { makePanelContext, TEST_PANEL_ID } from './panel-test-context.js'

const FIRE = {
  ruleId: 'rule-night',
  ruleName: 'Night sensors',
  deviceId: 3836,
  sourceDeviceId: 4138,
  recordId: 'rec-1',
  timestamp: 1_700_000_000_000,
}

const panels: NcAlarmPanelDevice[] = []

afterEach(() => {
  for (const panel of panels.splice(0)) panel.stopCountdown()
})

const DOOR = 4138

async function armed(options?: { readonly excludeDoor?: boolean }) {
  const reports: NcAlarmPublishReport[] = []
  const { ctx, cap } = makePanelContext(
    { exitDelaySec: 0, entryDelaySec: 0, triggeredDurationSec: 30 },
    [],
  )
  const panel = new NcAlarmPanelDevice(ctx)
  panels.push(panel)
  panel.setPublishHook((report) => {
    reports.push(report)
  })
  if (options?.excludeDoor === true) {
    panel.setArmGuard({
      openings: async () => ({
        open: [
          { deviceId: DOOR, name: 'Door', state: 'open', controllable: false, cap: 'contact' },
        ],
        unknown: [],
      }),
      secureOnArm: () => undefined,
      announceRefusal: () => undefined,
      announceCheckFailed: () => undefined,
    })
    await panel.applySettings({
      nonBlockingEdit: { mode: 'away', deviceId: DOOR, nonBlocking: true },
    })
  }
  await panel.armWith('away')
  return { panel, cap: cap(), reports }
}

describe('alarm-panel.trigger from an Action run', () => {
  it('a rule fire on the action origin is the press the panel claims (D705)', async () => {
    const h = await armed()
    expect(h.panel.currentState()).toBe('armed_away')
    await runWithCapCallContext(
      commandOrigin({
        kind: 'action',
        actionId: 'internal:alarm',
        runId: 'run-1',
        ruleFire: FIRE,
      }).context,
      () => h.cap.trigger({ deviceId: TEST_PANEL_ID }),
    )
    expect(h.panel.currentState()).toBe('triggered')
    const fired = h.reports.find((report) => report.transition?.kind === 'alarm-triggered')
    expect(fired?.transition?.source).toMatchObject({
      ruleId: FIRE.ruleId,
      sourceDeviceId: FIRE.sourceDeviceId,
    })
  })

  it('an Action press with no fire is refused while the arm excludes a sensor (D735)', async () => {
    const h = await armed({ excludeDoor: true })
    expect(h.panel.excludedDevices()).toContain(DOOR)
    await expect(
      runWithCapCallContext(
        commandOrigin({ kind: 'action', actionId: 'internal:alarm', runId: 'run-1' }).context,
        () => h.cap.trigger({ deviceId: TEST_PANEL_ID }),
      ),
    ).rejects.toThrow('no source')
    expect(h.panel.currentState()).toBe('armed_away')
  })

  it('a press with no command origin still triggers — it is a person, not an Action', async () => {
    const h = await armed({ excludeDoor: true })
    await h.cap.trigger({ deviceId: TEST_PANEL_ID })
    expect(h.panel.currentState()).toBe('triggered')
  })
})
