import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Script-runner cap. Models HA `script.*` entities on
 * `DeviceType.Script`. A Script is a pre-recorded action sequence
 * that can be invoked imperatively — optionally with a variables
 * map when the script declares input fields.
 *
 * Variable-support is signalled by `DeviceFeature.ScriptVariables`
 * so the UI gates a "with parameters" form without a slice fetch.
 */

export const ScriptRunnerStatusSchema = z.object({
  /** Whether the script is currently executing. */
  isRunning: z.boolean(),
  /** Ms epoch of the last invocation start. 0 when never run. */
  lastRunAt: z.number(),
  /** Outcome of the last completed run. Null when never run or still
   *  running. */
  lastRunSuccess: z.boolean().nullable(),
  /** Failure description from the last completed run. Null on success
   *  or when never run. */
  lastError: z.string().nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type ScriptRunnerStatus = z.infer<typeof ScriptRunnerStatusSchema>

export const scriptRunnerCapability = {
  name: 'script-runner',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Script],
  methods: {
    run: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Optional variables map — passed through to the upstream
         *  script. Provider rejects when the script doesn't declare
         *  input fields (gated by `DeviceFeature.ScriptVariables`). */
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Cancel a running script. Provider rejects when the script
     *  isn't currently running. */
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  status: {
    schema: ScriptRunnerStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI script tile reads
   * `isRunning` to render a spinner during execution and surfaces
   * `lastError` / `lastRunSuccess` in the recent-runs panel.
   */
  runtimeState: ScriptRunnerStatusSchema,

  /**
   * Runtime-state durability: **session** — a restored `isRunning: true` describes a process that died with the previous hub.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — transient; run results belong in a ledger.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IScriptRunnerProvider = InferProvider<typeof scriptRunnerCapability>
