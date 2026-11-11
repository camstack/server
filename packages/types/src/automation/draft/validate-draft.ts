/**
 * `validateDraft` — is what the model wrote a real, savable entity on THIS site?
 *
 * Three layers, all deterministic and offline:
 *   1. the real Zod schema of the kind (after {@link expandDraft});
 *   2. the kind's own author-time validator (`validateRecipeBounds`,
 *      `prepareRecipeUnits`, `validateSchedulerInput`, `validateComposition`);
 *   3. site facts a schema cannot know: the device exists, serves the cap, the
 *      field is one the vocabulary offers, the zone belongs to the camera, the
 *      action's open args are present and in range.
 *
 * Refusals are sentences a model can act on in a repair round
 * ({@link buildRepairPrompt}), each starting with where it is.
 */
import type { z } from 'zod'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { findVocabAction } from '../../device/cap-vocabulary/action-index.js'
import { DeviceType } from '../../device/device-type.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type CompositionTargetDescription,
  validateComposition,
} from '../../composition/validate-composition.js'
import { CompositionSchema } from '../../composition/composition.js'
import { capUnitResolver } from '../normalize-units.js'
import { prepareRecipeUnits } from '../prepare-units.js'
import { CurrentAutomationRecipeSchema, validateRecipeBounds } from '../recipe.js'
import type { AutomationWhen } from '../when.js'
import { forEachLeaf } from '../when.js'
import { ActionInputSchema } from '../action.js'
import { SchedulerInputSchema, validateSchedulerInput } from '../scheduler.js'
import type { SiteReading } from '../../time/time-spec.js'
import { recipeSiteIssues, stepGuardSiteIssues } from '../when-site.js'
import { expandDraft, isRecord } from './draft-json.js'
import { sliceCapOf } from './vocabulary-slice.js'
import type { DraftKind, DraftSite, DraftSiteDevice, DraftValidation } from './draft-types.js'

const MAX_ISSUES = 8
const CAMERA_TYPE = 'camera'

function zodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((i) => {
    const at = i.path.length === 0 ? '(root)' : i.path.join('.')
    return `${at}: ${i.message}`
  })
}

function deviceOf(site: DraftSite, id: number): DraftSiteDevice | undefined {
  return site.devices.find((d) => d.id === id)
}

function describeDevice(d: DraftSiteDevice): string {
  return `"${d.name}" (id ${d.id}, caps ${d.caps.join(', ')})`
}

function leafIssues(site: DraftSite, when: AutomationWhen, root: string): readonly string[] {
  const issues: string[] = []
  forEachLeaf(
    when,
    (leaf, path) => {
      const at = path.replace(/^when/, root)
      if (leaf.kind === 'device-becomes' || leaf.kind === 'device-is') {
        const device = deviceOf(site, leaf.deviceId)
        if (device === undefined) {
          issues.push(`${at}: no device has id ${leaf.deviceId}`)
          return
        }
        if (!device.caps.includes(leaf.cap)) {
          issues.push(`${at}: ${describeDevice(device)} does not serve cap "${leaf.cap}"`)
          return
        }
        const field = sliceCapOf(leaf.cap)?.fields.find((f) => f.path === leaf.fieldPath)
        if (field === undefined) {
          const known = (sliceCapOf(leaf.cap)?.fields ?? []).map((f) => f.path).join(', ')
          issues.push(
            `${at}: cap "${leaf.cap}" has no field "${leaf.fieldPath}" (fields: ${known})`,
          )
          return
        }
        const value = leaf.kind === 'device-becomes' ? leaf.becomes : leaf.value
        if (
          field.kind === 'enum' &&
          typeof value === 'string' &&
          !(field.values ?? []).includes(value)
        ) {
          issues.push(
            `${at}: "${value}" is not a value of ${leaf.cap}.${field.path} (one of ${(field.values ?? []).join(', ')})`,
          )
        }
        if (field.kind === 'boolean' && value !== undefined && typeof value !== 'boolean') {
          issues.push(
            `${at}: ${leaf.cap}.${field.path} is true or false, got ${JSON.stringify(value)}`,
          )
        }
        return
      }
      if (leaf.kind === 'detection' || leaf.kind === 'stationary') {
        for (const id of leaf.deviceIds) {
          const device = deviceOf(site, id)
          if (device === undefined || device.type !== CAMERA_TYPE) {
            issues.push(`${at}: device ${id} is not a camera`)
            continue
          }
          const bad = (leaf.zones ?? []).filter((z) => !(device.zones ?? []).includes(z))
          if (bad.length > 0) {
            issues.push(
              `${at}: camera "${device.name}" has no zone ${bad.join(', ')} (zones: ${(device.zones ?? []).join(', ')})`,
            )
          }
        }
        return
      }
      if (leaf.kind === 'device-fired') {
        if (deviceOf(site, leaf.deviceId) === undefined)
          issues.push(`${at}: no device has id ${leaf.deviceId}`)
        return
      }
      if (leaf.kind === 'device-event' && leaf.deviceId !== undefined) {
        if (deviceOf(site, leaf.deviceId) === undefined)
          issues.push(`${at}: no device has id ${leaf.deviceId}`)
      }
    },
    root,
  )
  return issues
}

interface StepLike {
  readonly kind: string
  readonly actionId?: string | undefined
  readonly cap?: string | undefined
  readonly args?: Readonly<Record<string, unknown>> | undefined
  readonly target?:
    | {
        readonly kind: string
        readonly ids?: readonly number[]
        readonly deviceType?: string
        readonly roomId?: string
      }
    | undefined
}

function stepIssues(site: DraftSite, step: StepLike, at: string): readonly string[] {
  if (step.kind === 'action') {
    const ok = site.actions.some((a) => a.id === step.actionId)
    return ok ? [] : [`${at}: no existing action "${step.actionId ?? ''}"`]
  }
  if (step.kind !== 'cap') return []
  const issues: string[] = []
  const found = step.actionId === undefined ? undefined : findVocabAction(step.actionId)
  if (step.actionId === undefined || found === undefined) {
    return [`${at}: "${step.actionId ?? ''}" is not a vocabulary action id`]
  }
  if (step.cap !== found.cap)
    issues.push(
      `${at}: action ${step.actionId} belongs to cap "${found.cap}", not "${step.cap ?? ''}"`,
    )
  const target = step.target
  if (target?.kind === 'devices') {
    for (const id of target.ids ?? []) {
      const device = deviceOf(site, id)
      if (device === undefined) issues.push(`${at}.target: no device has id ${id}`)
      else if (!device.caps.includes(found.cap)) {
        issues.push(
          `${at}.target: ${describeDevice(device)} cannot do ${step.actionId} (needs cap "${found.cap}")`,
        )
      }
    }
  }
  if (target?.kind === 'domain') {
    const room = target.roomId?.toLowerCase()
    const matches = site.devices.filter(
      (d) =>
        d.caps.includes(found.cap) &&
        (target.deviceType === undefined || d.type === target.deviceType) &&
        (room === undefined || d.room?.toLowerCase() === room),
    )
    if (matches.length === 0)
      issues.push(`${at}.target: the domain matches no device that can do ${step.actionId}`)
  }
  for (const open of found.action.openArgs ?? []) {
    const value = step.args?.[open.key]
    if (value === undefined) {
      if (open.optional !== true) issues.push(`${at}.args: ${step.actionId} needs "${open.key}"`)
      continue
    }
    if (open.offer.kind === 'number') {
      if (typeof value !== 'number') issues.push(`${at}.args.${open.key}: must be a number`)
      else if (
        (open.offer.min !== undefined && value < open.offer.min) ||
        (open.offer.max !== undefined && value > open.offer.max)
      ) {
        issues.push(
          `${at}.args.${open.key}: ${value} is outside ${open.offer.min ?? ''}..${open.offer.max ?? ''}`,
        )
      }
    }
    if (open.offer.kind === 'enum' && !open.offer.values.some((v) => v.value === value)) {
      issues.push(
        `${at}.args.${open.key}: "${String(value)}" is not one of ${open.offer.values.map((v) => v.value).join(', ')}`,
      )
    }
  }
  return issues
}

function describeSource(site: DraftSite): ReadonlyMap<string, CompositionSourceDescription> {
  return new Map(
    site.devices.map((d) => {
      const type = Object.values(DeviceType).find((t) => t === d.type)
      const found: CompositionSourceDescription = {
        kind: 'found',
        deviceId: d.id,
        caps: new Set(d.caps),
        ...(type === undefined ? {} : { deviceType: type }),
      }
      return [`${d.addonId}/${d.stableId}`, found] as const
    }),
  )
}

function describeTarget(
  site: DraftSite,
  ref: { addonId: string; stableId: string },
): CompositionTargetDescription {
  const device = site.devices.find((d) => d.addonId === ref.addonId && d.stableId === ref.stableId)
  const type = Object.values(DeviceType).find((t) => t === device?.type)
  if (device === undefined || type === undefined) return { kind: 'absent' }
  return {
    kind: 'found',
    deviceId: device.id,
    type,
    nativeCaps: new Map(device.caps.map((c) => [c, device.addonId] as const)),
  }
}

/** The site as the time checks read it. */
function readingOf(site: DraftSite): SiteReading {
  return { location: site.location, timeZone: site.timeZone }
}

function validateAutomation(site: DraftSite, json: unknown): DraftValidation {
  const parsed = CurrentAutomationRecipeSchema.safeParse(json)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const recipe = parsed.data
  const bounds = validateRecipeBounds(recipe)
  const issues = [
    ...(bounds === null ? [] : [`when: ${bounds}`]),
    ...leafIssues(site, recipe.when, 'when'),
    ...recipe.actions.flatMap((a, i) => stepIssues(site, a, `actions.${i}`)),
    ...recipeSiteIssues(recipe, readingOf(site)).map((i) => `${i.path}: ${i.message}`),
  ]
  if (issues.length > 0) return { ok: false, issues }
  const prepared = prepareRecipeUnits(recipe, capUnitResolver(ALL_CAPABILITY_DEFINITIONS))
  return prepared.ok
    ? { ok: true, draft: prepared.recipe }
    : { ok: false, issues: [prepared.error] }
}

function validateAction(site: DraftSite, json: unknown): DraftValidation {
  const parsed = ActionInputSchema.safeParse(json)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const issues = [
    ...parsed.data.steps.flatMap((s, i) => stepIssues(site, s, `steps.${i}`)),
    ...stepGuardSiteIssues(parsed.data.steps, readingOf(site), 'steps').map(
      (i) => `${i.path}: ${i.message}`,
    ),
  ]
  return issues.length > 0 ? { ok: false, issues } : { ok: true, draft: parsed.data }
}

function validateScheduler(site: DraftSite, json: unknown): DraftValidation {
  const parsed = SchedulerInputSchema.safeParse(json)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const input = parsed.data
  const verdict = validateSchedulerInput(input, readingOf(site))
  const issues: string[] = [
    ...(verdict.ok ? [] : verdict.issues.map((i) => `${i.path}: ${i.message}`)),
    ...(input.activeWhen === undefined ? [] : leafIssues(site, input.activeWhen, 'activeWhen')),
    ...input.profiles.flatMap((p, pi) => [
      ...(p.activeWhen === undefined
        ? []
        : leafIssues(site, p.activeWhen, `profiles.${pi}.activeWhen`)),
      ...p.points.flatMap((pt, qi) => [
        ...(pt.conditions === undefined
          ? []
          : leafIssues(site, pt.conditions, `profiles.${pi}.points.${qi}.conditions`)),
        ...pt.steps.flatMap((s, si) =>
          stepIssues(site, s, `profiles.${pi}.points.${qi}.steps.${si}`),
        ),
      ]),
    ]),
  ]
  return issues.length > 0 ? { ok: false, issues } : { ok: true, draft: input }
}

function validateCompositionDraft(site: DraftSite, json: unknown): DraftValidation {
  const parsed = CompositionSchema.safeParse(json)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const composition = parsed.data
  const target =
    composition.target.kind === 'existing' ? describeTarget(site, composition.target.device) : null
  const verdict = validateComposition(composition, {
    lookupCap: buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS),
    sources: describeSource(site),
    self: null,
    blockId: null,
    target,
    peers: [],
  })
  return verdict.ok
    ? { ok: true, draft: composition }
    : {
        ok: false,
        issues: verdict.problems.map((p) => `${p.path}: ${p.message}`),
      }
}

export function validateDraft(kind: DraftKind, json: unknown, site: DraftSite): DraftValidation {
  if (!isRecord(json)) return { ok: false, issues: ['(root): the draft must be one JSON object'] }
  const expanded = expandDraft(json)
  const verdict = ((): DraftValidation => {
    switch (kind) {
      case 'automation':
        return validateAutomation(site, expanded)
      case 'action':
        return validateAction(site, expanded)
      case 'scheduler':
        return validateScheduler(site, expanded)
      case 'composition':
        return validateCompositionDraft(site, expanded)
    }
  })()
  return verdict.ok ? verdict : { ok: false, issues: verdict.issues.slice(0, MAX_ISSUES) }
}
