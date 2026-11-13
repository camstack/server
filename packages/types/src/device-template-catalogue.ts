/**
 * The one catalogue of what a device template may name (D1021, D1029).
 *
 * Filters, the `range` global and the reserved names (`now`, `camera`, the
 * caller's recognition values) are listed here. The grammar's allow-list and
 * argument caps are derived from this module; nothing else keeps a second list.
 * The renderer imports this module through the
 * `@camstack/types/device-template-catalogue` subpath, never the types barrel
 * (D453), and sends the derived caps to the worker. The worker does not import it.
 */
import { z } from 'zod'

export const DEVICE_TEMPLATE_CATALOGUE_KINDS = ['filter', 'global', 'variable'] as const
export type DeviceTemplateCatalogueKind = (typeof DEVICE_TEMPLATE_CATALOGUE_KINDS)[number]

export const DEVICE_TEMPLATE_CATALOGUE_CATEGORIES = [
  'number',
  'unit',
  'text',
  'state',
  'time',
  'fallback',
  'loop',
  'variable',
] as const
export type DeviceTemplateCatalogueCategory = (typeof DEVICE_TEMPLATE_CATALOGUE_CATEGORIES)[number]

export const DEVICE_TEMPLATE_PARAM_TYPES = ['string', 'number', 'boolean'] as const
export type DeviceTemplateParamType = (typeof DEVICE_TEMPLATE_PARAM_TYPES)[number]

const deviceTemplateParamSchemaValue: z.ZodType<{
  name: string
  type: DeviceTemplateParamType
  optional: boolean
  default?: string | number | boolean
}> = z.object({
  name: z.string().min(1),
  type: z.enum(DEVICE_TEMPLATE_PARAM_TYPES),
  optional: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
})
export type DeviceTemplateParam = z.infer<typeof deviceTemplateParamSchemaValue>
export const deviceTemplateParamSchema: z.ZodType<DeviceTemplateParam> =
  deviceTemplateParamSchemaValue

const deviceTemplateCatalogueEntrySchemaValue: z.ZodType<{
  name: string
  kind: DeviceTemplateCatalogueKind
  category: DeviceTemplateCatalogueCategory
  params: DeviceTemplateParam[]
  descriptionKey: string
  exampleKey: string
}> = z.object({
  name: z.string().min(1),
  kind: z.enum(DEVICE_TEMPLATE_CATALOGUE_KINDS),
  category: z.enum(DEVICE_TEMPLATE_CATALOGUE_CATEGORIES),
  params: z.array(deviceTemplateParamSchema),
  descriptionKey: z.string().min(1),
  exampleKey: z.string().min(1),
})
export type DeviceTemplateCatalogueEntry = z.infer<typeof deviceTemplateCatalogueEntrySchemaValue>
export const deviceTemplateCatalogueEntrySchema: z.ZodType<DeviceTemplateCatalogueEntry> =
  deviceTemplateCatalogueEntrySchemaValue

export interface DeviceTemplateCatalogueText {
  readonly en: string
  readonly it: string
}

interface CatalogueCopy {
  readonly description: readonly [string, string]
  readonly example: readonly [string, string]
}

function param(
  name: string,
  type: DeviceTemplateParamType,
  optional: boolean,
  fallback?: string | number | boolean,
): DeviceTemplateParam {
  return fallback === undefined
    ? { name, type, optional }
    : { name, type, optional, default: fallback }
}

function entry(
  name: string,
  kind: DeviceTemplateCatalogueKind,
  category: DeviceTemplateCatalogueCategory,
  params: readonly DeviceTemplateParam[],
): DeviceTemplateCatalogueEntry {
  return {
    name,
    kind,
    category,
    params: [...params],
    descriptionKey: `uiLibrary.deviceTemplateCatalogue.${name}.description`,
    exampleKey: `uiLibrary.deviceTemplateCatalogue.${name}.example`,
  }
}

const DIGITS = param('digits', 'number', true, 0)
const FALLBACK_TEXT = param('fallback', 'string', false)
const FALSY = param('falsy', 'boolean', true, false)

/** Every name the engine allows, in the order operators meet them. */
export const DEVICE_TEMPLATE_CATALOGUE: readonly DeviceTemplateCatalogueEntry[] = [
  entry('unit', 'filter', 'unit', [
    param('symbol', 'string', false),
    param('from', 'string', true),
  ]),
  entry('round', 'filter', 'number', [DIGITS]),
  entry('trunc', 'filter', 'number', [DIGITS]),
  entry('onoff', 'filter', 'state', []),
  entry('default', 'filter', 'fallback', [FALLBACK_TEXT, FALSY]),
  entry('since', 'filter', 'time', []),
  entry('ago', 'filter', 'time', []),
  entry('format', 'filter', 'text', [param('pattern', 'string', false)]),
  entry('upper', 'filter', 'text', []),
  entry('lower', 'filter', 'text', []),
  entry('title', 'filter', 'text', []),
  entry('capitalize', 'filter', 'text', []),
  entry('trim', 'filter', 'text', []),
  entry('abs', 'filter', 'number', []),
  entry('int', 'filter', 'number', [param('fallback', 'number', true, 0)]),
  entry('float', 'filter', 'number', [param('fallback', 'number', true, 0)]),
  entry('length', 'filter', 'text', []),
  entry('d', 'filter', 'fallback', [FALLBACK_TEXT, FALSY]),
  entry('join', 'filter', 'text', [param('separator', 'string', true, '')]),
  entry('replace', 'filter', 'text', [
    param('old', 'string', false),
    param('new', 'string', false),
    param('count', 'number', true),
  ]),
  entry('first', 'filter', 'loop', []),
  entry('last', 'filter', 'loop', []),
  entry('sort', 'filter', 'loop', [
    param('reverse', 'boolean', true, false),
    param('caseSensitive', 'boolean', true, false),
  ]),
  entry('reverse', 'filter', 'loop', []),
  entry('sum', 'filter', 'number', []),
  entry('string', 'filter', 'text', []),
  entry('list', 'filter', 'loop', []),
  entry('truncate', 'filter', 'text', [
    param('length', 'number', false),
    param('killwords', 'boolean', true, false),
    param('end', 'string', true, '…'),
  ]),
  entry('time', 'filter', 'time', [param('pattern', 'string', false)]),
  entry('range', 'global', 'loop', [
    param('stop', 'number', false),
    param('start', 'number', true, 0),
    param('step', 'number', true, 1),
  ]),
  entry('now', 'variable', 'time', []),
  entry('camera', 'variable', 'variable', []),
  entry('loop', 'variable', 'loop', []),
  entry('lastPerson', 'variable', 'variable', []),
  entry('lastPlate', 'variable', 'variable', []),
]

const COPY: Readonly<Record<string, CatalogueCopy>> = {
  unit: {
    description: [
      'Converts a number from the field’s base unit and prints the symbol.',
      'Converte un numero dall’unità di base del campo e stampa il simbolo.',
    ],
    example: ["{{ garage.temperature | unit('°C') }}", "{{ garage.temperature | unit('°C') }}"],
  },
  round: {
    description: [
      'Rounds a number to the given decimals.',
      'Arrotonda un numero ai decimali indicati.',
    ],
    example: ['{{ garage.temperature | round(1) }}', '{{ garage.temperature | round(1) }}'],
  },
  trunc: {
    description: [
      'Cuts decimals toward zero, without rounding.',
      'Taglia i decimali verso zero, senza arrotondare.',
    ],
    example: ['{{ garage.temperature | trunc(1) }}', '{{ garage.temperature | trunc(1) }}'],
  },
  onoff: {
    description: ['Prints a boolean as ON or OFF.', 'Stampa un sì/no come ON oppure OFF.'],
    example: ['{{ garage.switch | onoff }}', '{{ garage.switch | onoff }}'],
  },
  default: {
    description: [
      'Replaces a missing value. The second argument also replaces a false or zero.',
      'Sostituisce un valore assente. Il secondo argomento sostituisce anche falso o zero.',
    ],
    example: ["{{ camera.lastPerson | default('') }}", "{{ camera.lastPerson | default('') }}"],
  },
  since: {
    description: [
      'How long ago a timestamp was, as “5 min”.',
      'Quanto tempo fa era un istante, come «5 min».',
    ],
    example: ['{{ garage.updated | since }}', '{{ garage.updated | since }}'],
  },
  ago: {
    description: [
      'The same duration as since, followed by “ago”.',
      'La stessa durata di since, seguita da «ago».',
    ],
    example: ['{{ garage.updated | ago }}', '{{ garage.updated | ago }}'],
  },
  format: {
    description: [
      'Prints one value with a single %s, %d or %.Nf placeholder.',
      'Stampa un valore con un solo segnaposto %s, %d o %.Nf.',
    ],
    example: [
      "{{ garage.temperature | format('%.1f') }}",
      "{{ garage.temperature | format('%.1f') }}",
    ],
  },
  upper: {
    description: ['Uppercase text.', 'Testo in maiuscolo.'],
    example: ['{{ camera.lastPerson | upper }}', '{{ camera.lastPerson | upper }}'],
  },
  lower: {
    description: ['Lowercase text.', 'Testo in minuscolo.'],
    example: ['{{ camera.lastPlate | lower }}', '{{ camera.lastPlate | lower }}'],
  },
  title: {
    description: ['Capitalises each word.', 'Mette la maiuscola a ogni parola.'],
    example: ['{{ camera.lastPerson | title }}', '{{ camera.lastPerson | title }}'],
  },
  capitalize: {
    description: ['Capitalises the first letter.', 'Mette la maiuscola alla prima lettera.'],
    example: ['{{ camera.lastPerson | capitalize }}', '{{ camera.lastPerson | capitalize }}'],
  },
  trim: {
    description: ['Removes spaces at both ends.', 'Toglie gli spazi alle estremità.'],
    example: ['{{ camera.lastPerson | trim }}', '{{ camera.lastPerson | trim }}'],
  },
  abs: {
    description: ['The absolute value of a number.', 'Il valore assoluto di un numero.'],
    example: ['{{ garage.power | abs }}', '{{ garage.power | abs }}'],
  },
  int: {
    description: ['The whole part of a number.', 'La parte intera di un numero.'],
    example: ['{{ garage.temperature | int }}', '{{ garage.temperature | int }}'],
  },
  float: {
    description: ['Reads the value as a decimal number.', 'Legge il valore come numero decimale.'],
    example: ['{{ garage.temperature | float }}', '{{ garage.temperature | float }}'],
  },
  length: {
    description: ['How many characters or items.', 'Quanti caratteri o elementi.'],
    example: ['{{ camera.lastPerson | length }}', '{{ camera.lastPerson | length }}'],
  },
  d: {
    description: ['The short name of default.', 'Il nome breve di default.'],
    example: ["{{ camera.lastPerson | d('') }}", "{{ camera.lastPerson | d('') }}"],
  },
  join: {
    description: ['Joins a list with a separator.', 'Unisce un elenco con un separatore.'],
    example: ["{{ range(3) | join(', ') }}", "{{ range(3) | join(', ') }}"],
  },
  replace: {
    description: [
      'Replaces text, optionally only the first few times.',
      'Sostituisce del testo, volendo solo le prime volte.',
    ],
    example: [
      "{{ camera.lastPlate | replace(' ', '') }}",
      "{{ camera.lastPlate | replace(' ', '') }}",
    ],
  },
  first: {
    description: ['The first item of a list.', 'Il primo elemento di un elenco.'],
    example: ['{{ range(3) | first }}', '{{ range(3) | first }}'],
  },
  last: {
    description: ['The last item of a list.', 'L’ultimo elemento di un elenco.'],
    example: ['{{ range(3) | last }}', '{{ range(3) | last }}'],
  },
  sort: {
    description: [
      'Sorts a list. The arguments reverse it or keep case.',
      'Ordina un elenco. Gli argomenti lo invertono o rispettano le maiuscole.',
    ],
    example: ['{{ range(3) | reverse | sort }}', '{{ range(3) | reverse | sort }}'],
  },
  reverse: {
    description: ['Reverses a list.', 'Inverte un elenco.'],
    example: ['{{ range(3) | reverse }}', '{{ range(3) | reverse }}'],
  },
  sum: {
    description: ['Adds the numbers in a list.', 'Somma i numeri di un elenco.'],
    example: ['{{ range(3) | sum }}', '{{ range(3) | sum }}'],
  },
  string: {
    description: ['Prints the value as text.', 'Stampa il valore come testo.'],
    example: ['{{ garage.temperature | string }}', '{{ garage.temperature | string }}'],
  },
  list: {
    description: ['Wraps the value in a list.', 'Mette il valore in un elenco.'],
    example: ['{{ garage.temperature | list }}', '{{ garage.temperature | list }}'],
  },
  truncate: {
    description: [
      'Shortens text to a length, with an ending.',
      'Accorcia il testo a una lunghezza, con una chiusura.',
    ],
    example: ['{{ camera.lastPerson | truncate(12) }}', '{{ camera.lastPerson | truncate(12) }}'],
  },
  time: {
    description: [
      'Prints a timestamp in the server’s time zone. Tokens: YYYY MM DD HH mm ss.',
      'Stampa un istante nel fuso del server. Segni: YYYY MM DD HH mm ss.',
    ],
    example: ["{{ now | time('HH:mm') }}", "{{ now | time('HH:mm') }}"],
  },
  range: {
    description: [
      'The integers up to stop, or from start to stop by step. At most 1000 items.',
      'Gli interi fino a stop, oppure da start a stop con step. Al massimo 1000 elementi.',
    ],
    example: [
      '{% for i in range(3) %}{{ i }}{% endfor %}',
      '{% for i in range(3) %}{{ i }}{% endfor %}',
    ],
  },
  now: {
    description: [
      'The hub clock. A bare now prints ISO; time prints a pattern.',
      'L’orologio dell’hub. now da solo stampa ISO; time stampa un formato.',
    ],
    example: ["{{ now | time('HH:mm') }}", "{{ now | time('HH:mm') }}"],
  },
  camera: {
    description: [
      'The device this text is written for. It stays correct when the text is copied to another camera.',
      'Il dispositivo per cui è scritto il testo. Resta corretto se il testo viene copiato su un’altra telecamera.',
    ],
    example: ['{{ camera.temperature }}', '{{ camera.temperature }}'],
  },
  loop: {
    description: [
      'The for-loop counter (index, length) inside {% for %}.',
      'Il contatore del ciclo (index, length) dentro {% for %}.',
    ],
    example: [
      '{% for i in range(3) %}{{ loop.index }}{% endfor %}',
      '{% for i in range(3) %}{{ loop.index }}{% endfor %}',
    ],
  },
  lastPerson: {
    description: [
      'The last person recognised on this camera, empty until there is one.',
      'L’ultima persona riconosciuta su questa telecamera, vuota finché non ce n’è una.',
    ],
    example: ['{{ camera.lastPerson }}', '{{ camera.lastPerson }}'],
  },
  lastPlate: {
    description: [
      'The last plate recognised on this camera, empty until there is one.',
      'L’ultima targa riconosciuta su questa telecamera, vuota finché non ce n’è una.',
    ],
    example: ['{{ camera.lastPlate }}', '{{ camera.lastPlate }}'],
  },
}

function buildText(): Readonly<Record<string, DeviceTemplateCatalogueText>> {
  const out: Record<string, DeviceTemplateCatalogueText> = {}
  for (const item of DEVICE_TEMPLATE_CATALOGUE) {
    const row = COPY[item.name]
    if (row === undefined) continue
    out[item.descriptionKey] = { en: row.description[0], it: row.description[1] }
    out[item.exampleKey] = { en: row.example[0], it: row.example[1] }
  }
  return out
}

/** English and Italian for every description and example key. */
export const DEVICE_TEMPLATE_CATALOGUE_TEXT: Readonly<Record<string, DeviceTemplateCatalogueText>> =
  buildText()

/** Names a template may use after `|`. Order matches the catalogue. */
export function deviceTemplateFilterNames(): readonly string[] {
  return DEVICE_TEMPLATE_CATALOGUE.filter((item) => item.kind === 'filter').map((item) => item.name)
}

/**
 * How many arguments a filter may take after its input. Derived from the
 * catalogue's parameter list — the grammar refuses anything past this.
 */
export function deviceTemplateFilterMaxParams(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const item of DEVICE_TEMPLATE_CATALOGUE) {
    if (item.kind !== 'filter') continue
    out[item.name] = item.params.length
  }
  return out
}

export interface DeviceTemplateCallableBounds {
  readonly name: string
  readonly min: number
  readonly max: number
}

/** Globals a template may call, with how many numbers each takes. */
export function deviceTemplateCallableBounds(): readonly DeviceTemplateCallableBounds[] {
  return DEVICE_TEMPLATE_CATALOGUE.filter((item) => item.kind === 'global').map((item) => ({
    name: item.name,
    min: Math.max(1, item.params.filter((p) => !p.optional).length),
    max: item.params.length,
  }))
}

const ROOT_VARIABLES: ReadonlySet<string> = new Set(['now', 'camera', 'loop'])

/** Names offered at the start of `{{ }}`: the clock, the for-loop, and `camera` when the field has a device. */
export function deviceTemplateRootVariables(): readonly DeviceTemplateCatalogueEntry[] {
  return DEVICE_TEMPLATE_CATALOGUE.filter(
    (item) => item.kind === 'variable' && ROOT_VARIABLES.has(item.name),
  )
}

/** Values the caller stores on `camera` (`lastPerson`, `lastPlate`), not device fields. */
export function deviceTemplateCameraValues(): readonly DeviceTemplateCatalogueEntry[] {
  return DEVICE_TEMPLATE_CATALOGUE.filter(
    (item) => item.kind === 'variable' && !ROOT_VARIABLES.has(item.name),
  )
}

export function deviceTemplateSignature(item: DeviceTemplateCatalogueEntry): string {
  if (item.kind === 'variable') return item.name
  const args = item.params.map((p) => (p.optional ? `${p.name}?` : p.name)).join(', ')
  return `${item.name}(${args})`
}

/** The operator-facing English (or Italian) sentence for a catalogue key. */
export function deviceTemplateCatalogueSentence(
  key: string,
  language: 'en' | 'it',
): string | undefined {
  return DEVICE_TEMPLATE_CATALOGUE_TEXT[key]?.[language]
}

/** A markdown table of the catalogue, for the public docs page. */
export function deviceTemplateCatalogueMarkdown(): string {
  const header = ['| Name | Kind | What it does | Example |', '| --- | --- | --- | --- |']
  const rows = DEVICE_TEMPLATE_CATALOGUE.map((item) => {
    const description = escapeCell(deviceTemplateCatalogueSentence(item.descriptionKey, 'en') ?? '')
    const example = escapeCell(deviceTemplateCatalogueSentence(item.exampleKey, 'en') ?? '')
    return `| \`${deviceTemplateSignature(item)}\` | ${item.kind} | ${description} | \`${example}\` |`
  })
  return [...header, ...rows].join('\n')
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|')
}
