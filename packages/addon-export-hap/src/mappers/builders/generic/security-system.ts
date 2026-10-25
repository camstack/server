/**
 * `alarm-panel` → `Service.SecuritySystem`.
 *
 * The lock builder's shape (a current/target pair, a hydrate, an `onSet`, a
 * slice subscription, a dispose) applied to the one device on the fleet where
 * reporting a state that is not true has a consequence worse than a stalled
 * motor. The mapping itself is NOT here: `security-state.ts` owns what the
 * panel's state looks like to HomeKit and `security-target.ts` owns what
 * HomeKit may ask for, both pure and both tested on their own. This file is
 * the service around them.
 *
 * ## The memo
 *
 * `pending`, `disarming` and `triggered` do not carry the mode the panel was
 * armed to — only the last settled state knows it. This builder is the caller
 * `security-state.ts` describes: it remembers the last settled arm and forgets
 * it on `disarmed`, because a memo that outlives a disarm makes the next
 * `arming` claim a target nobody asked for.
 *
 * The memo is deliberately NOT seeded from the controller's own write. HomeKit
 * already holds the target the operator just set; not writing it back is
 * exactly right. The cost is a panel armed from its own keypad during an exit
 * delay, where the target stays at whatever HomeKit last knew — a stale target
 * for the length of the delay, against inventing an intent, and the invention
 * is worse.
 *
 * ## `requiresCode`: the arm is REFUSED, not attempted
 *
 * HomeKit's SecuritySystem has no PIN prompt — there is no characteristic for
 * it and no way to ask the operator mid-write. So a panel that requires a code
 * cannot be armed or disarmed from the Home app, and this builder says so
 * twice: the write fails with `INSUFFICIENT_AUTHORIZATION` (iOS renders the
 * tile's failure) and a WARN names the device, the command and the mode.
 *
 * Sending the command code-less and letting the panel reject it was the
 * alternative. It is worse: the refusal costs a round trip, it is
 * indistinguishable from a broken panel in the log, and repeated code-less
 * attempts are what locks a real alarm panel out.
 */
import { type AlarmArmMode, AlarmPanelStatusSchema } from '@camstack/types'
import {
  Characteristic,
  type CharacteristicValue,
  HAPStatus,
  HapStatusError,
  Service,
} from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../../types.js'
import { applyServiceLabel } from '../service-label.js'
import { hapServiceName } from '../service-names.js'
import { applyUpdates, type CharacteristicUpdate } from './characteristic-update.js'
import { type ArmedMemo, armedMemoOf, securityStateFor } from './security-state.js'
import { armModeForTarget, targetValidValuesFor } from './security-target.js'

const SUBTYPE = 'alarm-panel'

/** The subset of the status this builder reads. */
const PanelReadSchema = AlarmPanelStatusSchema.pick({
  state: true,
  targetMode: true,
  availableModes: true,
  requiresCode: true,
})

/** What one status push produces: the writes, the memo to carry forward, and
 *  the two panel facts the `onSet` handler has to translate against. */
export interface SecurityUpdates {
  readonly updates: readonly CharacteristicUpdate[]
  readonly memo: ArmedMemo
  /** `null` when the status could not be read — never a default that pretends
   *  the panel answered. */
  readonly panel: {
    readonly availableModes: readonly AlarmArmMode[]
    readonly requiresCode: boolean
  } | null
}

/** Cap `targetMode` → settled memo word, when the status names one. */
function memoFromTargetMode(mode: AlarmArmMode | null | undefined): ArmedMemo {
  if (mode === null || mode === undefined) return null
  return `armed_${mode}`
}

/**
 * Turn a panel status into characteristic writes, folding the memo.
 *
 * A payload that does not match the cap's own schema yields NO updates and
 * leaves the memo alone — it is a status we could not read, not a panel that
 * changed. The caller logs the drop; a frozen characteristic is otherwise
 * indistinguishable from a quiet panel.
 *
 * Prefer `status.targetMode` over the in-process memo: a HomeKit process that
 * missed the settled `armed_*` slice used to map `pending` → DISARMED and hide
 * an entry delay (operator report 2026-10-03).
 */
export function securityUpdatesFor(status: unknown, memo: ArmedMemo): SecurityUpdates {
  const parsed = PanelReadSchema.safeParse(status)
  if (!parsed.success) return { updates: [], memo, panel: null }

  const fromCap = memoFromTargetMode(parsed.data.targetMode)
  const nextMemo =
    parsed.data.state === 'disarmed' ? null : (armedMemoOf(parsed.data.state) ?? fromCap ?? memo)
  const { current, target } = securityStateFor(parsed.data.state, nextMemo)
  return {
    updates: [
      { characteristic: Characteristic.SecuritySystemCurrentState, value: current },
      ...(target === null
        ? []
        : [{ characteristic: Characteristic.SecuritySystemTargetState, value: target }]),
    ],
    memo: nextMemo,
    panel: {
      availableModes: parsed.data.availableModes,
      requiresCode: parsed.data.requiresCode,
    },
  }
}

export async function buildSecuritySystem(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId, displayName } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  const label = hapServiceName([displayName], `Alarm ${numericDeviceId}`)
  const service = accessory.addService(Service.SecuritySystem, label, SUBTYPE)
  applyServiceLabel(service, label)

  // Mutable, because they are what the panel most recently told us and the
  // `onSet` handler has to translate against the CURRENT answer, not the one
  // that happened to be true at build time.
  let memo: ArmedMemo = null
  let availableModes: readonly AlarmArmMode[] = []
  let requiresCode = false
  /** Only log the `validValues` narrowing when it actually changes. */
  let lastValidValues = ''

  const applyValidValues = (): void => {
    const validValues = targetValidValuesFor(availableModes)
    if (validValues === null) {
      // Empty is UNKNOWN, not "none" — see security-target.ts. HomeKit keeps
      // its own four values and the panel is left able to refuse; the operator
      // gets told why a tile can fail.
      if (lastValidValues !== 'unconstrained') {
        lastValidValues = 'unconstrained'
        log.info(
          'export-hap: alarm panel named no arm modes — leaving HomeKit’s targets unconstrained',
          { meta: { subtype: SUBTYPE } },
        )
      }
      return
    }
    const key = validValues.join(',')
    if (key === lastValidValues) return
    lastValidValues = key
    // `setProps` types `validValues` as mutable; the copy is the boundary.
    service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({ validValues: [...validValues] })
    log.info('export-hap: alarm panel target constrained to the modes it accepts', {
      meta: { subtype: SUBTYPE, availableModes: [...availableModes], validValues },
    })
  }

  const apply = (status: unknown, source: string): void => {
    const next = securityUpdatesFor(status, memo)
    if (next.updates.length === 0) {
      log.debug('export-hap: alarm panel status did not match the cap schema — no update', {
        meta: { subtype: SUBTYPE, source },
      })
      return
    }
    memo = next.memo
    if (next.panel !== null) {
      availableModes = next.panel.availableModes
      requiresCode = next.panel.requiresCode
      applyValidValues()
    }
    applyUpdates(service, next.updates)
  }

  try {
    const status = await proxy.alarmPanel?.getStatus({})
    if (status !== undefined && status !== null) apply(status, 'getStatus')
  } catch (err) {
    log.debug('export-hap: alarm panel getStatus hydrate failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  service
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .onSet(async (value: CharacteristicValue) => {
      const target = typeof value === 'number' ? value : Number(value)
      const disarm = target === Characteristic.SecuritySystemTargetState.DISARM
      const mode = disarm ? null : armModeForTarget(target, availableModes)

      if (requiresCode) {
        // Refused, loudly, on both sides. HomeKit cannot carry a PIN on this
        // service and this addon will not invent one.
        log.warn(
          'export-hap: alarm panel requires a PIN — HomeKit cannot supply one, command REFUSED',
          { meta: { subtype: SUBTYPE, command: disarm ? 'disarm' : 'arm', mode, target } },
        )
        throw new HapStatusError(HAPStatus.INSUFFICIENT_AUTHORIZATION)
      }

      if (!disarm && mode === null) {
        // Either a value HomeKit never sends, or an arm this panel accepts no
        // mode for. Both are writes we refuse to translate rather than guess.
        log.warn('export-hap: alarm panel cannot honour this HomeKit arm target — REFUSED', {
          meta: { subtype: SUBTYPE, target, availableModes: [...availableModes] },
        })
        throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST)
      }

      try {
        // No optimistic write of the current state: the panel pushes the real
        // transition (`arming` → `armed_*`) through the slice, and claiming
        // ARMED while the exit delay runs is the lie this builder refuses.
        //
        // Do NOT rethrow HapStatusError on failure (lock builder precedent).
        // Arm awaits openings — night coverage can take seconds — and
        // SERVICE_COMMUNICATION_FAILURE made iOS mark the accessory
        // unreachable after a refusal or a slow second tap. The slice
        // subscribe below resyncs Current/Target when the panel publishes.
        if (mode === null) {
          await proxy.alarmPanel?.disarm({})
        } else {
          await proxy.alarmPanel?.arm({ mode })
        }
      } catch (err) {
        log.warn('export-hap: alarm panel command failed', {
          meta: {
            subtype: SUBTYPE,
            command: mode === null ? 'disarm' : 'arm',
            mode,
            error: errMsg(err),
          },
        })
      }
    })

  const unsubscribe =
    proxy.state.alarmPanel?.subscribe((value) => {
      if (value === undefined || value === null) return
      apply(value, 'slice')
    }) ?? null

  return {
    async dispose(): Promise<void> {
      try {
        unsubscribe?.()
      } catch {
        /* already gone */
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
