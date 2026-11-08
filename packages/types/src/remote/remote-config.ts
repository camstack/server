/**
 * The per-device configuration of the `remote` Customize extension (D963) and
 * the layout payload of the `remote` template kind. Pure data: no runtime, no
 * node dependency, so the admin UI imports the same schemas the server checks.
 *
 * A binding is the SAME shape an Action step has (`AutomationCapStepBaseSchema`: a
 * cap method called on a device with arguments), narrowed to ONE device: an IR
 * code is `ir-transmitter.send` on the transmitter, a smart TV is a `switch` or a
 * vendor cap — the remote does not know which. How many times a command is sent
 * is the CALLER's (`sendCommand({ repeat })`), never stored here.
 */
import { z } from 'zod'
import { AutomationCapStepBaseSchema } from '../automation/recipe.js'
import {
  customKeyOfRole,
  isRemoteCustomKey,
  isRemoteRole,
  isRemoteWidgetRole,
  RemoteRoleSchema,
} from './remote-roles.js'
import {
  irSourceProblem,
  MAX_REMOTE_SOURCES,
  type RemoteSource,
  REMOTE_STEP_DELAY_DEFAULT_MS,
  REMOTE_STEP_DELAY_MAX_MS,
  REMOTE_STEP_DELAY_MIN_MS,
  RemoteSourceSchema,
  remoteSourceSteps,
} from './remote-sources.js'

export const RemoteBindingActionSchema = AutomationCapStepBaseSchema.omit({
  target: true,
  actionId: true,
}).extend({
  deviceId: z.number().int().nonnegative(),
})
export type RemoteBindingAction = z.infer<typeof RemoteBindingActionSchema>

export const RemoteBindingSchema = z.object({
  action: RemoteBindingActionSchema,
})
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

/**
 * The source rules: every step role is bound, ids and names are unique, a
 * channel number belongs to one `digits` source, and no name or id is another
 * source's number (a name, an id and a number must reach one source, never two).
 */
function refineSources(
  config: { readonly bindings: Record<string, unknown>; readonly sources: readonly RemoteSource[] },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>()
  const names = new Set<string>()
  const numbers = new Set<string>()
  config.sources.forEach((source, index) => {
    const fail = (message: string, field: string): void => {
      ctx.addIssue({ code: 'custom', message, path: ['sources', index, field] })
    }
    if (ids.has(source.id)) fail(`source id "${source.id}" is used twice`, 'id')
    ids.add(source.id)
    const name = source.name.trim().toLowerCase()
    if (names.has(name)) fail(`source name "${source.name}" is used twice`, 'name')
    names.add(name)
    if (source.kind === 'digits') {
      if (numbers.has(source.number)) fail(`channel ${source.number} is declared twice`, 'number')
      numbers.add(source.number)
    }
    if (source.kind === 'ir') {
      const problem = irSourceProblem(source)
      if (problem !== null) fail(problem, 'payload')
    }
    for (const role of remoteSourceSteps(source)) {
      if (isRemoteWidgetRole(role)) {
        fail(`"${source.name}" presses ${role}, a layout widget, not a command`, 'steps')
      } else if (config.bindings[role] === undefined) {
        fail(`"${source.name}" presses ${role}, which is not bound`, 'steps')
      }
    }
  })
  // A name or an id that is ANOTHER source's channel number would reach two
  // sources (selectSource by name or id, playMedia by number). Its own is fine.
  config.sources.forEach((source, index) => {
    for (const other of config.sources) {
      if (other.kind !== 'digits' || other === source) continue
      for (const field of ['name', 'id'] as const) {
        if (source[field].trim() !== other.number) continue
        ctx.addIssue({
          code: 'custom',
          message: `${field} "${source[field]}" is the channel number of "${other.name}"`,
          path: ['sources', index, field],
        })
      }
    }
  })
}

/** A stored source that was left out of a read, and why (the UI shows it). */
export const RemoteRefusedSourceSchema = z.object({
  /** Position in the stored list. */
  index: z.number().int().nonnegative(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  reason: z.string(),
})
export type RemoteRefusedSource = z.infer<typeof RemoteRefusedSourceSchema>

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
    /**
     * The sources the operator DECLARED (planning#460). A custom button is a
     * button, never a source; a config with none offers no source at all.
     */
    sources: z.array(RemoteSourceSchema).max(MAX_REMOTE_SOURCES).default([]),
    /** The pause between two steps of a source: the television's receiver, not a repeat. */
    stepDelayMs: z
      .number()
      .int()
      .min(REMOTE_STEP_DELAY_MIN_MS)
      .max(REMOTE_STEP_DELAY_MAX_MS)
      .default(REMOTE_STEP_DELAY_DEFAULT_MS),
    power: z.object({ mode: RemotePowerModeSchema }),
    /**
     * READ-ONLY: sources a stored configuration carries that no longer parse,
     * left out of `sources` with the reason (`readStoredRemoteConfig`). Never
     * stored: the store strips it on write.
     */
    refusedSources: z.array(RemoteRefusedSourceSchema).optional(),
  })
  .superRefine((config, ctx) => {
    const roles = Object.keys(config.bindings)
    if (roles.length > MAX_REMOTE_BINDINGS) {
      ctx.addIssue({
        code: 'custom',
        message: 'too many bindings',
        path: ['bindings'],
      })
    }
    for (const role of roles) {
      if (isRemoteWidgetRole(role)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${role}" is a layout widget, not a command: it cannot be bound`,
          path: ['bindings', role],
        })
      } else if (!isRemoteRole(role)) {
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
    refineSources(config, ctx)
  })
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>

const StoredSourcesShapeSchema = z.looseObject({ sources: z.array(z.unknown()) })
const SourceIdentitySchema = z.object({ id: z.string(), name: z.string() }).partial()

export type StoredRemoteConfigRead =
  | { readonly success: true; readonly data: RemoteConfig }
  | { readonly success: false; readonly issues: number }

/**
 * Read a STORED configuration. A single source that no longer parses (a code
 * the transmitter could not send, a malformed entry) must not make the whole
 * remote unreadable: it is left out and named in `refusedSources`, and the other
 * sources and the bindings load. Writing stays strict (`RemoteConfigSchema`).
 */
export function readStoredRemoteConfig(raw: unknown): StoredRemoteConfigRead {
  const shape = StoredSourcesShapeSchema.safeParse(raw)
  if (!shape.success) return finishRead(RemoteConfigSchema.safeParse(raw))
  const kept: unknown[] = []
  const refused: RemoteRefusedSource[] = []
  shape.data.sources.forEach((candidate, index) => {
    const parsed = RemoteSourceSchema.safeParse(candidate)
    const problem =
      parsed.success && parsed.data.kind === 'ir' ? irSourceProblem(parsed.data) : null
    if (parsed.success && problem === null) {
      kept.push(candidate)
      return
    }
    const identity = SourceIdentitySchema.safeParse(candidate)
    const reason = problem ?? parsed.error?.issues[0]?.message ?? 'not a source'
    refused.push({
      index,
      id: identity.success ? (identity.data.id ?? null) : null,
      name: identity.success ? (identity.data.name ?? null) : null,
      reason,
    })
  })
  const read = finishRead(RemoteConfigSchema.safeParse({ ...shape.data, sources: kept }))
  if (!read.success || refused.length === 0) return read
  return { success: true, data: { ...read.data, refusedSources: refused } }
}

function finishRead(
  parsed: ReturnType<typeof RemoteConfigSchema.safeParse>,
): StoredRemoteConfigRead {
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, issues: parsed.error.issues.length }
}

export const EMPTY_REMOTE_CONFIG: RemoteConfig = {
  layoutTemplateId: null,
  defaultTransmitterId: null,
  bindings: {},
  customButtons: [],
  sources: [],
  stepDelayMs: REMOTE_STEP_DELAY_DEFAULT_MS,
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
  /** The declared source last sent; unknown after a power off or a channel step. */
  source: z.object({ name: z.string(), at: z.number() }).nullable().default(null),
})
export type RemoteAssumedState = z.infer<typeof RemoteAssumedStateSchema>

export const EMPTY_REMOTE_ASSUMED_STATE: RemoteAssumedState = {
  power: null,
  muted: null,
  source: null,
}

// ── The `remote` template kind: a button grid ────────────────────────────────

export const MAX_LAYOUT_SPAN = 24
export const MAX_LAYOUT_GROUPS = 50

/**
 * Closed vocabularies the UI knows how to DRAW (D973). A layout names a shape,
 * a tone or a frame; it never carries a style. An addon that contributes a
 * component picks from these lists — it ships no UI code.
 */
export const REMOTE_BUTTON_SHAPES = ['rect', 'rounded', 'round', 'pill'] as const
export const RemoteButtonShapeSchema = z.enum(REMOTE_BUTTON_SHAPES)
export type RemoteButtonShape = z.infer<typeof RemoteButtonShapeSchema>

export const REMOTE_BUTTON_TONES = [
  'neutral',
  'accent',
  'danger',
  'red',
  'green',
  'yellow',
  'blue',
] as const
export const RemoteButtonToneSchema = z.enum(REMOTE_BUTTON_TONES)
export type RemoteButtonTone = z.infer<typeof RemoteButtonToneSchema>

export const REMOTE_GROUP_FRAMES = [
  'none',
  'panel',
  'divider',
  'dpad',
  'rocker-v',
  'rocker-h',
  'keypad',
] as const
export const RemoteGroupFrameSchema = z.enum(REMOTE_GROUP_FRAMES)
export type RemoteGroupFrame = z.infer<typeof RemoteGroupFrameSchema>

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
  /** Absent = the plain rendering every layout had before shapes existed. */
  shape: RemoteButtonShapeSchema.optional(),
  tone: RemoteButtonToneSchema.optional(),
  /** The group this button belongs to; it must lie inside that group's rectangle. */
  groupId: z.string().min(1).max(40).optional(),
})
export type RemoteLayoutButton = z.infer<typeof RemoteLayoutButtonSchema>

/**
 * A rectangle of the grid that moves as ONE thing and is drawn with a frame: a
 * titled panel, a section divider, a D-pad ring. `componentId` names the palette
 * entry it came from (informational: the layout is self-contained).
 */
export const RemoteLayoutGroupSchema = z.object({
  id: z.string().min(1).max(40),
  componentId: z.string().min(1).max(80),
  frame: RemoteGroupFrameSchema,
  row: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  col: z.number().int().min(0).max(MAX_LAYOUT_SPAN),
  rowSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  colSpan: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
  title: z.string().min(1).max(40).optional(),
  /**
   * How much room a divider takes: `compact` (the default) is a slim rule,
   * `normal` a full grid row. Other frames ignore it.
   */
  size: z.enum(['compact', 'normal']).optional(),
  /** Keep the title in the layout but draw only the rule. */
  hideTitle: z.boolean().optional(),
})
export type RemoteLayoutGroup = z.infer<typeof RemoteLayoutGroupSchema>

export interface LayoutRect {
  readonly row: number
  readonly col: number
  readonly rowSpan: number
  readonly colSpan: number
}

export function rectsOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan &&
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan
  )
}

export function rectContains(outer: LayoutRect, inner: LayoutRect): boolean {
  return (
    inner.row >= outer.row &&
    inner.col >= outer.col &&
    inner.row + inner.rowSpan <= outer.row + outer.rowSpan &&
    inner.col + inner.colSpan <= outer.col + outer.colSpan
  )
}

interface GroupedGrid {
  readonly columns: number
  readonly rows: number
  readonly buttons: readonly RemoteLayoutButton[]
  readonly groups?: readonly RemoteLayoutGroup[] | undefined
}

/**
 * The group rules of a layout: inside the grid, no two groups overlap, a
 * member lies inside its group, a divider holds nothing, and a button that is
 * not a member never sits inside someone else's rectangle (a group moves as
 * one thing, so a stray key under it would be left behind).
 */
function refineGroups(grid: GroupedGrid, ctx: z.RefinementCtx): void {
  const groups = grid.groups ?? []
  const byId = new Map<string, RemoteLayoutGroup>()
  const fail = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: 'custom', message, path })
  }
  groups.forEach((group, index) => {
    if (byId.has(group.id)) fail(`group id "${group.id}" is used twice`, ['groups', index, 'id'])
    byId.set(group.id, group)
    if (group.row + group.rowSpan > grid.rows || group.col + group.colSpan > grid.columns) {
      fail(`group "${group.id}" leaves the grid`, ['groups', index])
    }
    for (let other = 0; other < index; other += 1) {
      const earlier = groups[other]
      if (earlier !== undefined && rectsOverlap(earlier, group)) {
        fail(`groups "${earlier.id}" and "${group.id}" overlap`, ['groups', index])
        return
      }
    }
  })
  grid.buttons.forEach((button, index) => {
    if (button.groupId !== undefined) {
      const group = byId.get(button.groupId)
      if (group === undefined) {
        fail(`button "${button.id}" names the unknown group "${button.groupId}"`, [
          'buttons',
          index,
          'groupId',
        ])
        return
      }
      if (group.frame === 'divider') {
        fail(`a divider group ("${group.id}") holds no buttons`, ['buttons', index, 'groupId'])
      }
      if (!rectContains(group, button)) {
        fail(`button "${button.id}" lies outside its group "${group.id}"`, ['buttons', index])
      }
      return
    }
    const foreign = groups.find((group) => rectsOverlap(group, button))
    if (foreign !== undefined) {
      fail(`button "${button.id}" lies inside group "${foreign.id}" but is not a member`, [
        'buttons',
        index,
      ])
    }
  })
}

export const RemoteLayoutPayloadSchema = z
  .object({
    columns: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
    rows: z.number().int().min(1).max(MAX_LAYOUT_SPAN),
    buttons: z.array(RemoteLayoutButtonSchema).max(MAX_REMOTE_BINDINGS),
    groups: z.array(RemoteLayoutGroupSchema).max(MAX_LAYOUT_GROUPS).optional(),
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
    refineGroups(grid, ctx)
  })
export type RemoteLayoutPayload = z.infer<typeof RemoteLayoutPayloadSchema>
