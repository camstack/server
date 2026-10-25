/**
 * Alarm-panel declaration, convergence and the join onto the notification
 * centre. Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, boot
 * extraction): only the visibility of the entry points changed. Every
 * dependency is read through the deps object.
 */

import type { AddonContext } from '@camstack/types'
import { DeclaredDevices, errMsg } from '@camstack/types'
import {
  NC_ALARM_DECLARATION,
  NC_INTEGRATION_NAME,
} from '../../notification-center/alarm/alarm-panel-declaration.js'
import { NcAlarmPanelDevice } from '../../notification-center/alarm/alarm-panel-device.js'
import { ncAlarmPanelPort } from '../../notification-center/alarm/alarm-panel-port.js'
import { NotificationCenter } from '../../notification-center/index.js'
import type { AlarmPanelConvergence } from '../alarm-panel-convergence.js'
import { startAlarmPanelConvergence } from '../alarm-panel-convergence.js'
import type { AnalyticsApi } from './boot-types.js'
import { PIPELINE_ANALYTICS_ADDON_ID } from './boot-types.js'

export interface BuildAlarmPanelDeps {
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly shuttingDown: () => boolean
  readonly alarmPanelConvergence: () => AlarmPanelConvergence | null
  readonly setAlarmPanelConvergence: (value: AlarmPanelConvergence | null) => void
  readonly alarmPanelDevice: () => NcAlarmPanelDevice | null
  readonly setAlarmPanelDevice: (value: NcAlarmPanelDevice | null) => void
  readonly notificationCenter: () => NotificationCenter | null
  readonly alarmPanelWired: () => boolean
  readonly setAlarmPanelWired: (value: boolean) => void
}

export class BuildAlarmPanel {
  constructor(protected readonly deps: BuildAlarmPanelDeps) {}

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get shuttingDown(): boolean {
    return this.deps.shuttingDown()
  }

  protected get alarmPanelConvergence(): AlarmPanelConvergence | null {
    return this.deps.alarmPanelConvergence()
  }

  protected set alarmPanelConvergence(value: AlarmPanelConvergence | null) {
    this.deps.setAlarmPanelConvergence(value)
  }

  protected get alarmPanelDevice(): NcAlarmPanelDevice | null {
    return this.deps.alarmPanelDevice()
  }

  protected set alarmPanelDevice(value: NcAlarmPanelDevice | null) {
    this.deps.setAlarmPanelDevice(value)
  }

  protected get notificationCenter(): NotificationCenter | null {
    return this.deps.notificationCenter()
  }

  protected get alarmPanelWired(): boolean {
    return this.deps.alarmPanelWired()
  }

  protected set alarmPanelWired(value: boolean) {
    this.deps.setAlarmPanelWired(value)
  }

  /** Declare typed collections up-front so the first insert doesn't race with
   *  a CREATE TABLE. Idempotent. */
  /**
   * DECLARE the Notification Center's alarm panel.
   *
   * The procedure is not here any more — `DeclaredDevices` owns the
   * get-or-create, the FIXED integration and its every-pass `fixed`
   * re-assertion, the adopt-don't-skip rule, the hub-ownership gate and the D49
   * second read that stops a transiently empty index re-stamping the declared
   * name over the operator's rename. What is left is the declaration and the
   * ports.
   */
  /**
   * Arm the declaration as BACKGROUND work and return immediately.
   *
   * `initialize()` is on the critical path of the whole capability graph — the
   * runner publishes an addon's manifest only after it returns — so an await
   * that can outlive a boot is an outage with a fixed blast radius
   * (docs/architecture/addon-lifecycle.md). This one could not merely outlive a
   * boot, it could not possibly succeed during one: the first port call is
   * `integrations.getByAddonId`, a hub-CORE namespace served by `$core-caps`,
   * which `main.ts` registers only AFTER `app.init()` returns, i.e. after the
   * whole addon boot. Core caps are excluded from the boot-window retry, so the
   * call sat in the 60 s UDS timeout — measured at 61 s of DETERMINISTIC delay
   * on every boot of this addon (D167).
   *
   * And the wait bought nothing. The retry ladder is the real path: on the live
   * boot of 2026-08-19 the panel was declared at t0+204 s with `attempts=1`,
   * i.e. on the ladder's FIRST tick, after the doomed boot attempt had already
   * been paid for.
   */
  armAlarmPanelDeclaration(api: AnalyticsApi): void {
    void this.declareAlarmPanel(api).catch((err: unknown) => {
      // `declareAlarmPanel` handles its own failures; a throw ESCAPING it is a
      // bug in the arming path itself, and an unhandled rejection in a runner
      // is a silent one.
      this.ctx.logger.warn(
        'alarm panel declaration could not be armed — the Alarm tab stays empty until this addon restarts',
        { meta: { error: errMsg(err) } },
      )
    })
  }

  async declareAlarmPanel(api: AnalyticsApi): Promise<void> {
    if (await this.attemptAlarmPanelDeclaration(api)) return
    // Nothing to converge to once the process is going away: this runs off the
    // boot path now, so it can land AFTER `onShutdown` has already stopped the
    // convergence it knew about, and a timer armed then is one nobody clears.
    if (this.shuttingDown) return
    // The boot pass could not make it. It is NOT a one-shot: `reconcile` is
    // idempotent and the failure that produces this is transient (a child that
    // forked before the parent registered `integrations`). Converge, bounded —
    // the alternative, which this hub shipped, is a permanently empty Alarm tab
    // on an install whose panel exists.
    this.alarmPanelConvergence = startAlarmPanelConvergence({
      attempt: () => this.attemptAlarmPanelDeclaration(api),
      logger: this.ctx.logger.child('alarm'),
    })
  }

  /**
   * ONE declaration pass. True once there is nothing left to converge to.
   *
   * `owned: false` counts as landed: an agent node does not own the declaration
   * and must not retry a thing it is never going to do.
   */
  async attemptAlarmPanelDeclaration(api: AnalyticsApi): Promise<boolean> {
    // The hub-ownership gate, the get-or-create, the `fixed` re-assertion and
    // the adopt-don't-skip rule all live in `DeclaredDevices` now. What is left
    // here is the wiring of ports to this addon's `ctx` and holding the result.
    const declared = new DeclaredDevices({
      logger: this.ctx.logger.child('alarm'),
      addonId: PIPELINE_ANALYTICS_ADDON_ID,
      devices: this.ctx.kernel.devices,
      localNodeId: this.ctx.kernel.localNodeId,
      getIntegration: async (addonId) => api.integrations.getByAddonId.query({ addonId }),
      createIntegration: async (input) => api.integrations.create.mutate(input),
      updateIntegration: async ({ id, info }) => {
        await api.integrations.update.mutate({ id, info, skipRestart: true })
      },
      listOwnDevices: async () =>
        api.deviceManager.listAll.query({
          addonId: PIPELINE_ANALYTICS_ADDON_ID,
        }),
    })
    try {
      const result = await declared.reconcile({
        integrationName: NC_INTEGRATION_NAME,
        devices: [NC_ALARM_DECLARATION],
      })
      for (const outcome of result.devices) this.holdAlarmPanel(outcome.device)
      if (!result.owned) return true
    } catch (err) {
      // A panel that could not be created is a feature missing, not a hub
      // down. Loud, because the alternative is an operator arming an alarm
      // that does not exist.
      this.ctx.logger.warn('alarm panel could not be ensured — rules still notify', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
    if (this.alarmPanelDevice === null) return false
    // A pass that lands AFTER the centre was built has to join the two halves
    // itself — the boot-order call in `startNotificationCenter` has already
    // happened and will not run again.
    if (this.notificationCenter !== null) this.wireAlarmPanel(this.notificationCenter)
    return true
  }

  /**
   * Keep the constructed panel, if that is what came back.
   *
   * An `instanceof` narrowing rather than a cast: `devices.create` promises an
   * `IDevice`, and the only honest way to know it is the alarm is to ask. A
   * cast here would compile against any future device class and fail at the
   * first `settings()` call, in production, with the tab already open.
   */
  holdAlarmPanel(device: unknown): void {
    if (!(device instanceof NcAlarmPanelDevice)) {
      this.ctx.logger.warn('alarm panel is not the expected device class — settings tab disabled')
      return
    }
    this.alarmPanelDevice = device
  }

  /**
   * Join the panel and the Notification Center, once both exist.
   *
   * They are built in that order (`declareAlarmPanel` runs before the centre is
   * constructed) and neither can reach the other on its own, so the join is
   * here. A node with no panel simply never calls it, and the cap answers
   * `deviceId: null` — which is what an agent node should say.
   */
  wireAlarmPanel(center: NotificationCenter): void {
    const panel = this.alarmPanelDevice
    if (panel === null || this.alarmPanelWired) return
    this.alarmPanelWired = true
    center.setAlarmPanel(ncAlarmPanelPort(panel))
    panel.setPublishHook((report) => center.onAlarmPublish(report))
    // …and the other direction: what the panel has to ask the centre before it
    // can arm. Which devices a mode covers is a function of the RULE SET, and
    // the rule set lives in the centre — the panel keeps no list of its own
    // (D62).
    panel.setArmGuard(center.alarmArmGuard())
    // SEED the gate's mirror before anything can be evaluated. The panel
    // publishes on CHANGE, so without this the `deviceState` gate would answer
    // `undefined` — and therefore refuse every armed rule — until the first
    // reload tick, i.e. for up to thirty seconds after every deploy.
    center.onAlarmPublish({
      state: panel.currentState(),
      target: panel.currentTarget(),
      transition: null,
    })
    this.ctx.logger.info('alarm panel wired to the notification center', {
      tags: { deviceId: panel.id },
    })
  }
}
