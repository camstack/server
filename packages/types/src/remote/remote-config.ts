/**
 * The per-device configuration of the `remote` Customize extension (D963) and
 * the layout payload of the `remote` template kind. Pure data: no runtime, no
 * node dependency, so the admin UI imports the same schemas the server checks.
 *
 * A binding is the SAME shape an Action step has (`AutomationCapStepSchema`: a
 * cap method called on a device with arguments), narrowed to ONE device: an IR
 * code is `ir-transmitter.send` on the transmitter, a smart TV is a `switch` or a
 * vendor cap — the remote does not know which. How many times a command is sent
 * is the CALLER's (`sendCommand({ repeat })`), never stored here.
 */
import { z } from 'zod'
import { AutomationCapStepSchema } from '../automation/recipe.js'
import {
  customKeyOfRole,
  isRemoteCustomKey,
  isRemoteRole,
  RemoteRoleSchema,
} from './remote-roles.js'

export const RemoteBindingActionSchema = AutomationCapStepSchema.extend({
  deviceId: z.number().int().nonnegative(),
})
export type RemoteBindingAction = z.infer<typeof RemoteBindingActionSchema>

export const RemoteBindingSchema = z.object({ action: RemoteBindingActionSchema })
export type RemoteBinding = z.infer<typeof RemoteBindingSchema>

export const RemoteCustomButtonSchema = z.object({
  /** The slug after `custom:` in the role. */
  key: z.string().refine(isRemoteCustomKey, { message: 'a lowercase slug' }),
  /** What the operator calls it, and what a voice command may name. */
  name: z.string().min(1).max(60),
})
export type RemoteCustomButton = z.infer<typeof RemoteCustomButtonSchema>

export const REMOTE_POWER_MODES = ['toggle', 'discrete'] as const
export const RemotePowerModeSchema = z.enum(REMOTE_POWER_MODES)
export type RemotePowerMode = z.infer<typeof RemotePowerModeSchema>

export const MAX_REMOTE_BINDINGS = 200
export const MAX_REMOTE_CUSTOM_BUTTONS = 100

export const RemoteConfigSchema = z
  .object({
    layoutTemplateId: z.string().min(1).nullable(),
    /**
     * The transmitter device new bindings and an import send through. A binding
     * names its own device, so one command may override it.
     */
    defaultTransmitterId: z.number().int().nonnegative().nullable().default(null),
    /** Keyed by role. A role with no entry falls back to the native cap. */
    bindings: z.record(z.string(), RemoteBindingSchema),
    customButtons: z.array(RemoteCustomButtonSchema).max(MAX_REMOTE_CUSTOM_BUTTONS),
    power: z.object({ mode: RemotePowerModeSchema }),
  })
  .superRefine((config, ctx) => {
    const roles = Object.keys(config.bindings)
    if (roles.length > MAX_REMOTE_BINDINGS) {
      ctx.addIssue({ code: 'custom', message: 'too many bindings', path: ['bindings'] })
    }
    for (const role of roles) {
      if (!isRemoteRole(role)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${role}" is not a role`,
          path: ['bindings', role],
        })
      }
    }
    const keys = new Set<string>()
    config.customButtons.forEach((button, index) => {
      if (keys.has(button.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `custom button "${button.key}" is listed twice`,
          path: ['customButtons', index, 'key'],
        })
      }
      keys.add(button.key)
    })
    for (const role of roles) {
      const key = customKeyOfRole(role)
      if (key !== null && !keys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `${role} is bound but has no entry in customButtons`,
          path: ['bindings', role],
        })
      }
    }
  })
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>

export const EMPTY_REMOTE_CONFIG: RemoteConfig = {
  layoutTemplateId: null,
  defaultTransmitterId: null,
  bindings: {},
  customButtons: [],
  power: { mode: 'discrete' },
}

/**
 * What the remote last SENT and therefore guesses about a device that does not
 * report it (infrared has no feedback). Persisted next to the config so a hub
 * restart does not forget it, and never recorded in history: it is a guess, not
 * a reading. A reading from a running source always outranks it.
 */
export const RemoteAssumedStateSchema = z.object({
  power: z.object({ state: z.enum(['on', 'off']), at: z.number() }).nullable(),
  muted: z.object({ value: z.boolean(), at: z.number() }).nullable(),
})
export type RemoteAssumedState = z.infer<typeof RemoteAssumedStateSchema>

export const EMPTY_REMOTE_ASSUMED_STATE: RemoteAssumedState = { power: null, muted: null }

// ── The `remote` template kind: a button grid ────────────────────────────────

export const MAX_LAYOUT_SPAN = 24

export const RemoteLayoutButtonSchema = z.object({
  id: z.string().min(1).max(40),
  /** 0-based grid position. */
  row: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  col: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  rowSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  colSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  icon: z.string().min(1).max(60).optional(),
  label: z.string().min(1).max(40).optional(),
  role: RemoteRoleSchema,
})
export type RemoteLayoutButton = z.infer<typeof RemoteLayoutButtonSchema>

export const RemoteLayoutPayloadSchema = z
  .object({
    columns: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
    rows: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
    buttons: z.array(RemoteLayoutButtonSchema).max(MAX_REMOTE_BINDINGS),
  })
  .superRefine((grid, ctx) => {
    const ids = new Set<string>()
    const taken = new Map<string, string>()
    grid.buttons.forEach((button, index) => {
      if (ids.has(button.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `button id "${button.id}" is used twice`,
          path: ['buttons', index, 'id'],
        })
      }
      ids.add(button.id)
      if (button.row + button.rowSpan > grid.rows || button.col + button.colSpan > grid.columns) {
        ctx.addIssue({
          code: 'custom',
          message: `button "${button.id}" leaves the grid`,
          path: ['buttons', index],
        })
        return
      }
      for (let r = button.row; r < button.row + button.rowSpan; r += 1) {
        for (let c = button.col; c < button.col + button.colSpan; c += 1) {
          const cell = `${r}:${c}`
          const other = taken.get(cell)
          if (other !== undefined) {
            ctx.addIssue({
              code: 'custom',
              message: `buttons "${other}" and "${button.id}" overlap`,
              path: ['buttons', index],
            })
            return
          }
          taken.set(cell, button.id)
        }
      }
    })
  })
export type RemoteLayoutPayload = z.infer<typeof RemoteLayoutPayloadSchema>
