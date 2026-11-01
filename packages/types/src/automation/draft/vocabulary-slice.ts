/**
 * `buildVocabularySlice` — the part of a site one description is about.
 *
 * A model cannot be handed 300 devices. The slice token-matches the description
 * against device names, rooms, types, cap nouns, field labels and action
 * phrases (English and Italian), keeps the best-scoring devices and the caps
 * they serve, and renders everything as at most {@link SLICE_MAX_LINES} prompt
 * lines. Deterministic: the same (site, description) always gives the same
 * slice, ties broken by device id.
 */
import { CAP_VOCABULARY_BY_NAME } from '../../device/cap-vocabulary/vocabulary.js'
import type {
  LooseVocabAction,
  LooseVocabStateTrigger,
  VocabEventExcused,
  VocabEventTrigger,
} from '../../device/cap-vocabulary/types.js'
import { overlap, tokenize } from './draft-text.js'
import {
  type DraftSite,
  type DraftSiteDevice,
  type SliceAction,
  type SliceCap,
  type SliceDevice,
  type SliceField,
  type SliceOpenArg,
  SLICE_MAX_LINES,
  type VocabularySlice,
} from './draft-types.js'

const FALLBACK_DEVICES = 14

function fieldOf(trigger: LooseVocabStateTrigger): SliceField {
  switch (trigger.kind) {
    case 'boolean':
      return { path: trigger.field, kind: 'boolean', label: trigger.label.en }
    case 'numeric':
      return { path: trigger.field, kind: 'number', label: trigger.label.en }
    case 'enum':
      return {
        path: trigger.field,
        kind: 'enum',
        label: trigger.label.en,
        values: trigger.values.map((v) => v.value),
      }
    case 'value':
      return { path: trigger.field, kind: 'value', label: trigger.label.en }
  }
}

function openArgOf(arg: NonNullable<LooseVocabAction['openArgs']>[number]): SliceOpenArg {
  const optional = arg.optional === true
  switch (arg.offer.kind) {
    case 'number':
      return {
        key: arg.key,
        kind: 'number',
        optional,
        ...(arg.offer.min === undefined ? {} : { min: arg.offer.min }),
        ...(arg.offer.max === undefined ? {} : { max: arg.offer.max }),
      }
    case 'enum':
      return {
        key: arg.key,
        kind: 'enum',
        optional,
        values: arg.offer.values.map((v) => v.value),
      }
    case 'text':
      return { key: arg.key, kind: 'text', optional }
    case 'boolean':
      return { key: arg.key, kind: 'boolean', optional }
    case 'dynamic':
      return { key: arg.key, kind: 'dynamic', optional }
  }
}

function isEventTrigger(e: VocabEventTrigger | VocabEventExcused): e is VocabEventTrigger {
  return 'category' in e
}

/** Everything the vocabulary says about one cap, in slice form; `null` for a cap with no operator-facing entry. */
export function sliceCapOf(cap: string): SliceCap | null {
  const entry = CAP_VOCABULARY_BY_NAME[cap]
  if (entry === undefined || entry.scope !== 'device') return null
  const actions: SliceAction[] = (entry.actions ?? []).map((a) => ({
    id: a.id,
    cap,
    method: a.method,
    phrase: a.phrase.en,
    args: a.args ?? {},
    openArgs: (a.openArgs ?? []).map(openArgOf),
  }))
  const categories = [
    ...Object.values(entry.events ?? {})
      .filter(isEventTrigger)
      .map((e) => e.category),
    ...(entry.extraEvents ?? []).map((e) => e.category),
  ]
  return {
    cap,
    noun: entry.noun?.en ?? cap,
    fields: (entry.state ?? []).map(fieldOf),
    actions,
    categories: categories.map((c) => String(c)),
  }
}

function capWords(
  slice: SliceCap,
  entry: NonNullable<(typeof CAP_VOCABULARY_BY_NAME)[string]>,
): string {
  const labels = (entry.state ?? []).flatMap((s) => [s.label.en, s.label.it])
  const actions = (entry.actions ?? []).flatMap((a) => [a.label.en, a.label.it, a.phrase.it])
  return [slice.cap, slice.noun, entry.noun?.it ?? '', ...labels, ...actions].join(' ')
}

function scoreDevice(device: DraftSiteDevice, words: readonly string[]): number {
  const own = tokenize(`${device.name} ${device.room ?? ''} ${device.type}`)
  let score = overlap(own, words) * 4
  for (const cap of device.caps) {
    const sliceCap = sliceCapOf(cap)
    const entry = CAP_VOCABULARY_BY_NAME[cap]
    if (sliceCap === null || entry === undefined) continue
    score += overlap(tokenize(capWords(sliceCap, entry)), words)
  }
  const roomWords = tokenize(device.room ?? '')
  if (roomWords.length > 0 && overlap(roomWords, words) === roomWords.length) score += 2
  return score
}

function describeCap(cap: SliceCap): string {
  const fields = cap.fields
    .map((f) => `${f.path}:${f.kind === 'enum' ? (f.values ?? []).join('|') : f.kind}`)
    .join(',')
  const actions = cap.actions
    .map((a) => {
      const open = a.openArgs.map((o) => {
        const range = o.min === undefined ? '' : ` ${o.min}-${o.max ?? ''}`
        const values = o.values === undefined ? '' : ` ${o.values.join('|')}`
        return `${o.key}${range}${values}`
      })
      return open.length === 0 ? a.id : `${a.id}(${open.join(';')})`
    })
    .join(' ')
  const events = cap.categories.length === 0 ? '' : ` events ${cap.categories.join(',')}`
  return `cap ${cap.cap} [${cap.noun}] fields ${fields === '' ? '-' : fields}; actions ${actions === '' ? '-' : actions}${events}`
}

function deviceLine(d: SliceDevice): string {
  const zones = d.zones.length === 0 ? '' : ` zones=${d.zones.join('|')}`
  return `D${d.id} "${d.name}" ${d.type} @${d.room ?? '-'} caps=${d.caps.join(',')}${zones}`
}

function renderLines(
  rooms: readonly string[],
  devices: readonly SliceDevice[],
  caps: readonly SliceCap[],
  internal: VocabularySlice['internalActions'],
): readonly string[] {
  return [
    `rooms: ${rooms.join(', ')}`,
    ...devices.map(deviceLine),
    ...caps.map(describeCap),
    ...(internal.length === 0
      ? []
      : [`existing actions: ${internal.map((a) => `${a.id}="${a.name}"`).join(' ')}`]),
  ]
}

function capsOf(devices: readonly SliceDevice[]): readonly SliceCap[] {
  const names = [...new Set(devices.flatMap((d) => d.caps))].toSorted()
  return names.flatMap((n) => {
    const c = sliceCapOf(n)
    return c === null ? [] : [c]
  })
}

export interface SliceOptions {
  readonly maxLines?: number
}

export function buildVocabularySlice(
  site: DraftSite,
  description: string,
  options: SliceOptions = {},
): VocabularySlice {
  const maxLines = options.maxLines ?? SLICE_MAX_LINES
  const words = tokenize(description)
  const scored = site.devices
    .map((d) => ({ d, score: scoreDevice(d, words) }))
    .toSorted((a, b) => b.score - a.score || a.d.id - b.d.id)
  const matched = scored.filter((s) => s.score > 0)
  const pool = matched.length > 0 ? matched : scored.slice(0, FALLBACK_DEVICES)
  let chosen: SliceDevice[] = pool.map(({ d, score }) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    room: d.room,
    addonId: d.addonId,
    stableId: d.stableId,
    caps: d.caps.filter((c) => sliceCapOf(c) !== null),
    zones: d.zones ?? [],
    score,
  }))
  const internal = site.actions.filter((a) => overlap(tokenize(a.name), words) > 0)
  let lines = renderLines(site.rooms, chosen, capsOf(chosen), internal)
  while (lines.length > maxLines && chosen.length > 1) {
    chosen = chosen.slice(0, -1)
    lines = renderLines(site.rooms, chosen, capsOf(chosen), internal)
  }
  const caps = capsOf(chosen)
  return {
    rooms: site.rooms,
    devices: chosen,
    caps,
    zones: [...new Set(chosen.flatMap((d) => d.zones))].toSorted(),
    eventCategories: [...new Set(caps.flatMap((c) => c.categories))].toSorted(),
    internalActions: internal,
    deviceTypes: [...new Set(chosen.map((d) => d.type))].toSorted(),
    timeZone: site.timeZone,
    lines: lines.slice(0, maxLines),
  }
}
