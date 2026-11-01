/**
 * The prompt a draft is asked for with: a compact grammar of the kind (at most
 * {@link GRAMMAR_MAX_LINES} lines), the enumerated ids of the vocabulary slice,
 * a few worked examples chosen by similarity to the description, and the
 * description itself (Italian or English). Pure text in, text out.
 */
import { compositionTargetCaps } from './composition-caps.js'
import { similarity } from './draft-text.js'
import type { DraftFewShot, DraftKind, VocabularySlice } from './draft-types.js'

export const GRAMMAR_MAX_LINES = 40
export const FEW_SHOT_COUNT = 3

const COMMON: readonly string[] = [
  'Reply with ONE JSON object and nothing else. Use ONLY the ids listed under "Site".',
  'A cap step names a vocabulary action: {"kind":"cap","actionId":"switch.on","target":{"kind":"devices","ids":[1]}}.',
  'cap, method and fixed args come from the action; add "args" only for the open args the action lists, e.g. brightness.set(level 0-100) -> "args":{"level":40}.',
  'A target is {"kind":"devices","ids":[..]} or {"kind":"domain","deviceType":"light","roomId":"Salone"} (every such device in the room).',
  'Wait step: {"kind":"wait","seconds":30}. Never invent a device, cap, field, zone or action id.',
]

const WHEN_GRAMMAR: readonly string[] = [
  'when is ONE tree: {"kind":"all"|"any","children":[..]} | {"kind":"not","child":..} | a leaf. Nest at most 3 levels.',
  'Event leaves (an instant): ',
  '  {"kind":"device-becomes","deviceId":N,"cap":"..","fieldPath":"..","becomes":true|"open"|42,"forMs":0}',
  '  {"kind":"device-event","category":"doorbell.onPressed","deviceId":N}',
  '  {"kind":"detection","subjects":[{"macro":"person"|"animal"|"vehicle"|"package"}],"deviceIds":[cameras],"zones":[..]}',
  '  {"kind":"schedule","at":{"kind":"clock","hh":22,"mm":30},"days":["mon",..]} or at {"kind":"sun","event":"sunset","offsetMin":-15}',
  '  {"kind":"interval","minutes":10}   {"kind":"manual"}',
  'State leaf (a condition that holds): {"kind":"device-is","deviceId":N,"cap":"..","fieldPath":"..","operator":"eq|ne|gt|gte|lt|lte","value":..}',
  'A tree with events fires when one occurs AND the whole tree is true; never put two events in an "all", never negate an event.',
]

const GRAMMARS: Readonly<Record<DraftKind, readonly string[]>> = {
  automation: [
    'KIND automation: {"when":<tree>,"actions":[<step>,..],"runMode":{"mode":"single"|"restart"|"cooldown","minutes":N}}',
    ...WHEN_GRAMMAR,
    '"actions" run in order, at least one. runMode is optional; use cooldown only when the description asks to not repeat within minutes.',
  ],
  action: [
    'KIND action: a reusable named sequence the operator runs by hand: {"name":"..","steps":[<step>,..]} (1-20 steps, no triggers).',
    'Name it from the description in its own language.',
  ],
  scheduler: [
    'KIND scheduler: a weekly timeline: {"name":"..","priority":0,"profiles":[{"id":"p1","name":"..","days":["mon",..],"points":[<point>,..]}]}',
    'point: {"id":"a","at":{"kind":"clock","hh":7,"mm":0}|{"kind":"sun","event":"sunrise","offsetMin":0},"mode":"edge"|"hold"|"release","steps":[<step>,..]}',
    '  edge = do the steps once at that time; hold = steps that lead to a state (switch.on, cover.close, brightness.set) kept true until the next point;',
    '  release = ends a hold, no steps. A hold may only use actions that set a state; a toggle or wait cannot be held.',
    'Optional "conditions" on a point and "activeWhen" on a profile/scheduler are STATE trees only (device-is leaves under all/any/not).',
    'Days: mon tue wed thu fri sat sun. Point ids are unique inside a profile; profile ids unique.',
  ],
  composition: [
    'KIND composition: a NEW derived device: {"target":{"kind":"new","type":"sensor","role":".."},"features":[{"kind":"fields","cap":"..","fields":{"<field>":<source>}}]}',
    'source: {"kind":"from","source":{"addonId":"..","stableId":".."},"cap":"..","fieldPath":".."}',
    '  | {"kind":"expression","expr":"round(avg(a, b), 1)","bindings":{"a":{"kind":"from","source":{..},"cap":"..","fieldPath":".."}, ..}}',
    '  | {"kind":"aggregate","reducer":"mean|median|min|max|sum|any|all","reads":[{"source":{..},"cap":"..","fieldPath":".."}],"publish":"value","empty":"null"}',
    'Expressions use binding names, numbers and: avg min max sum round any all within(binding, ms) now. Booleans: any(a, b).',
    'Every REQUIRED field of the built cap must be given (listed below). One feature per cap.',
  ],
}

function renderTargetCaps(): readonly string[] {
  return compositionTargetCaps().map(
    (c) => `built cap ${c.cap}: fields ${c.fields.join(', ')}; required: ${c.required.join(', ')}`,
  )
}

export interface DraftPrompt {
  readonly system: string
  readonly user: string
}

export function grammarFor(kind: DraftKind): readonly string[] {
  return [...COMMON, ...GRAMMARS[kind]].slice(0, GRAMMAR_MAX_LINES)
}

/** The `count` pool entries most similar to the description; ties keep pool order. */
export function selectFewShots(
  description: string,
  pool: readonly DraftFewShot[],
  count = FEW_SHOT_COUNT,
): readonly DraftFewShot[] {
  return pool
    .map((shot, index) => ({ shot, index, sim: similarity(description, shot.description) }))
    .toSorted((a, b) => b.sim - a.sim || a.index - b.index)
    .slice(0, count)
    .map((s) => s.shot)
}

export function buildDraftPrompt(
  kind: DraftKind,
  slice: VocabularySlice,
  description: string,
  fewShots: readonly DraftFewShot[],
): DraftPrompt {
  const system = [
    'You turn a home-automation request (Italian or English) into one JSON entity for a smart-home hub.',
    ...grammarFor(kind),
  ].join('\n')
  const site = [`Site (time zone ${slice.timeZone}):`, ...slice.lines]
  const composition = kind === 'composition' ? renderTargetCaps() : []
  const shots = fewShots.flatMap((s, i) => [
    `Example ${i + 1}: ${s.description}`,
    JSON.stringify(s.entity),
  ])
  const user = [
    ...site,
    ...composition,
    ...(shots.length === 0 ? [] : ['', ...shots]),
    '',
    `Request: ${description}`,
    'JSON:',
  ].join('\n')
  return { system, user }
}

/** The follow-up message after a refused draft: what was wrong, and to resend the whole JSON. */
export function buildRepairPrompt(issues: readonly string[]): string {
  return [
    'The JSON was refused. Fix every problem and reply with the complete corrected JSON object only:',
    ...issues.map((i) => `- ${i}`),
  ].join('\n')
}
