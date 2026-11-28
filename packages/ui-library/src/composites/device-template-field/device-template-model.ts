import { holdVarSlots, templateCapKey } from '@dominevo/types'
import {
  type DeviceTemplateCatalogueEntry,
  DEVICE_TEMPLATE_CATALOGUE,
  type DeviceTemplateParam,
  deviceTemplateParamChoices,
} from '@dominevo/types/device-template-catalogue'

/** What a field of the text may hold: the declared value kind of the place the template feeds. */
export type DeviceTemplateAccepts = 'number' | 'string' | 'boolean' | 'any'

/** A field kind as `getWireableFields` reports it. */
export type DeviceFieldKind = 'string' | 'number' | 'boolean' | 'enum'

/**
 * A number slot takes numbers, a yes/no slot takes booleans; a text slot prints
 * anything, so it takes every kind (a temperature in a sentence is the common case).
 * An unknown kind is never offered to a typed slot.
 */
export function fieldAccepts(accepts: DeviceTemplateAccepts, kind: string): boolean {
  if (accepts === 'any' || accepts === 'string') return true
  return kind === accepts
}

export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'ref'
      /** The token exactly as written, filters included. */
      readonly raw: string
      readonly alias: string
      /** The path after the alias, as written (`temperature`, `climate.temperature`). */
      readonly path: string
    }

/** Names the run-time owns besides devices: `{{vars.x}}` is a variable slot, never a device. */
const NON_DEVICE_HEADS: ReadonlySet<string> = new Set(['vars'])

const REF_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\.([^\s|}]+)\s*(?:\|[^}]*)?\}\}/g

/** Split a template into text and device references; the pieces re-join to the input. */
export function parseTemplateSegments(text: string): readonly TemplateSegment[] {
  const segments: TemplateSegment[] = []
  let last = 0
  for (const match of text.matchAll(REF_PATTERN)) {
    const [raw, alias, path] = match
    if (alias === undefined || path === undefined || NON_DEVICE_HEADS.has(alias)) continue
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) })
    segments.push({ kind: 'ref', raw, alias, path })
    last = match.index + raw.length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

export function hasDeviceRefs(text: string): boolean {
  return parseTemplateSegments(text).some((s) => s.kind === 'ref')
}

/** One cap of the device and the first path segments its fields start with. */
export interface DeviceCapFields {
  readonly cap: string
  readonly paths: readonly string[]
}

function head(path: string): string {
  return path.split('.')[0] ?? path
}

/**
 * The token for one value. The short form `{{ alias.field }}` resolves only when exactly one
 * cap of the device carries a field of that name; otherwise the cap is spelled out
 * (`{{ alias.cap_name.field }}`), as the renderer requires.
 */
function escapeUnitLiteral(unit: string): string {
  return unit.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

export function deviceTemplateToken(
  alias: string,
  pick: { readonly cap: string; readonly path: string },
  caps: readonly DeviceCapFields[],
  unit?: string,
): string {
  const field = head(pick.path)
  const owners = caps.filter((c) => c.paths.some((p) => head(p) === field))
  const ambiguous = owners.some((c) => c.cap !== pick.cap)
  const base = ambiguous
    ? `{{ ${alias}.${templateCapKey(pick.cap)}.${pick.path} }}`
    : `{{ ${alias}.${pick.path} }}`
  if (unit === undefined || unit === '') return base
  return base.replace(/\s*\}\}$/, ` | unit('${escapeUnitLiteral(unit)}') }}`)
}

export interface TemplateSelection {
  readonly start: number
  readonly end: number
}

export interface TemplateInsertion {
  readonly value: string
  readonly cursor: number
}

/** Put `token` at the selection (replacing it), clamped to the text. */
export function insertTemplateToken(
  value: string,
  selection: TemplateSelection,
  token: string,
): TemplateInsertion {
  const start = Math.min(Math.max(selection.start, 0), value.length)
  const end = Math.min(Math.max(selection.end, start), value.length)
  return {
    value: `${value.slice(0, start)}${token}${value.slice(end)}`,
    cursor: start + token.length,
  }
}

/** A chip's label: the alias and the path, without braces or filters. */
export function chipLabel(segment: Extract<TemplateSegment, { kind: 'ref' }>): string {
  return `${segment.alias}.${segment.path}`
}

/**
 * Which `{{…}}` the consumer fills itself, so the hub is not asked about them:
 *  - `vars` (default): only `{{ vars.name }}`, the one slot an action run holds (`holdVarSlots`);
 *  - `placeholders`: also a bare `{{name}}`, the notification text variables.
 */
export type DeviceTemplateHeldSlots = 'vars' | 'placeholders'

const PLACEHOLDER_SLOT = /\{\{\s*(?:vars\.)?\w+\s*\}\}/g

/** What the hub is asked to vet: the text with the consumer's own slots set aside, as the run-time does. */
export function textForDeviceCheck(text: string, held: DeviceTemplateHeldSlots = 'vars'): string {
  return held === 'placeholders' ? text.replace(PLACEHOLDER_SLOT, '·') : holdVarSlots(text, '·')
}

/** True when the text carries template markup beyond the consumer's own slots. */
export function carriesDeviceTemplate(
  text: string,
  held: DeviceTemplateHeldSlots = 'vars',
): boolean {
  return /\{\{|\{%/.test(textForDeviceCheck(text, held))
}

/** Where the caret sits in a template, and the prefix the operator is still typing. */
export type TemplateCaretContext =
  | { readonly kind: 'none' }
  | { readonly kind: 'expression'; readonly prefix: string }
  | { readonly kind: 'field'; readonly alias: string; readonly prefix: string }
  | { readonly kind: 'filter'; readonly prefix: string }
  | {
      readonly kind: 'argument'
      /** The filter being called: `unit` in `| unit(`. */
      readonly filter: string
      /** Zero-based position of the argument under the caret. */
      readonly index: number
      /** The argument as typed so far, opening quote included: what a pick replaces. */
      readonly prefix: string
      /** What was typed inside the quotes, for narrowing the list. */
      readonly typed: string
      /** The quote the operator opened, or null when none yet. */
      readonly quote: "'" | '"' | null
      /** The `alias.field` the pipe chain starts from, when it is one. */
      readonly source: TemplateFieldSource | null
    }

/** The device field a pipe chain starts from: `garage.temperature`. */
export interface TemplateFieldSource {
  readonly alias: string
  readonly path: string
}

function clampCaret(value: string, caret: number): number {
  return Math.min(Math.max(caret, 0), value.length)
}

/** Index of the `{{` that contains the caret, or -1 when the caret is outside one. */
function openExpression(value: string, caret: number): number {
  const before = value.slice(0, caret)
  const open = before.lastIndexOf('{{')
  if (open < 0) return -1
  const close = before.lastIndexOf('}}')
  return close > open ? -1 : open
}

/** The last `|` that is not inside a quoted string. */
function lastUnquotedPipe(text: string): number {
  let quote: string | undefined
  let at = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== undefined) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '|') at = i
  }
  return at
}

/** The first unquoted `|`: where the piped value ends. */
function firstUnquotedPipe(text: string): number {
  let quote: string | undefined
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== undefined) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '|') return i
  }
  return -1
}

const FIELD_SOURCE = /^([a-z][a-z0-9_]*)\.([A-Za-z0-9_.]+)$/

function fieldSourceOf(inner: string): TemplateFieldSource | null {
  const pipe = firstUnquotedPipe(inner)
  const head = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const match = FIELD_SOURCE.exec(head)
  return match?.[1] !== undefined && match[2] !== undefined
    ? { alias: match[1], path: match[2] }
    : null
}

/** The `alias.field` the expression around the caret pipes from, or null. */
export function templateFieldSource(value: string, caret: number): TemplateFieldSource | null {
  const at = clampCaret(value, caret)
  const open = openExpression(value, at)
  return open < 0 ? null : fieldSourceOf(value.slice(open + 2, at))
}

interface OpenCall {
  readonly filter: string
  readonly index: number
  readonly arg: string
}

/** `name(a, b` -> the call still open at the end of `text`; null when it is closed or not a call. */
function openCall(text: string): OpenCall | null {
  const head = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text)
  if (head?.[1] === undefined) return null
  let quote: string | undefined
  let index = 0
  let argStart = head[0].length
  for (let i = head[0].length; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== undefined) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === ')') return null
    else if (ch === ',') {
      index += 1
      argStart = i + 1
    }
  }
  return { filter: head[1], index, arg: text.slice(argStart).trimStart() }
}

function argumentContext(inner: string, call: OpenCall): TemplateCaretContext {
  const first = call.arg[0]
  const quote = first === "'" || first === '"' ? first : null
  const typed = quote === null ? call.arg : call.arg.slice(1)
  if (quote !== null && typed.includes(quote)) return { kind: 'none' }
  return {
    kind: 'argument',
    filter: call.filter,
    index: call.index,
    prefix: call.arg,
    typed,
    quote,
    source: fieldSourceOf(inner),
  }
}

export function templateCaretContext(value: string, caret: number): TemplateCaretContext {
  const at = clampCaret(value, caret)
  const open = openExpression(value, at)
  if (open < 0) return { kind: 'none' }
  const inner = value.slice(open + 2, at)
  const pipe = lastUnquotedPipe(inner)
  if (pipe >= 0) {
    const call = openCall(inner.slice(pipe + 1))
    if (call !== null) return argumentContext(inner, call)
    const name = /^[A-Za-z0-9_]*/.exec(inner.slice(pipe + 1).trimStart())?.[0] ?? ''
    return { kind: 'filter', prefix: name }
  }
  const trimmed = inner.trimStart()
  const field = /^([a-z][a-z0-9_]*)\.(.*)$/.exec(trimmed)
  if (field?.[1] !== undefined && field[2] !== undefined) {
    return { kind: 'field', alias: field[1], prefix: field[2] }
  }
  return {
    kind: 'expression',
    prefix: /[A-Za-z0-9_]*$/.exec(trimmed)?.[0] ?? '',
  }
}

function argumentOffersValues(filter: string, index: number): boolean {
  const source = DEVICE_TEMPLATE_CATALOGUE.find((item) => item.name === filter)?.params[index]
    ?.values
  return source !== undefined
}

/** True when the caret just landed on `{{`, `|` or `alias.` — the popover opens itself. */
export function templateSuggestTrigger(value: string, caret: number): boolean {
  const before = value.slice(0, clampCaret(value, caret))
  if (before.endsWith('{{') || before.endsWith('|')) return true
  const ctx = templateCaretContext(value, caret)
  if (ctx.kind === 'argument')
    return ctx.typed === '' && argumentOffersValues(ctx.filter, ctx.index)
  if (!before.endsWith('.')) return false
  return ctx.kind === 'field'
}

export interface CatalogueCall {
  readonly kind: 'filter' | 'global' | 'variable'
  readonly name: string
  readonly args: readonly string[]
}

export interface CatalogueInsertion {
  readonly value: string
  readonly cursor: number
  readonly select: TemplateSelection | null
}

function splice(value: string, start: number, end: number, text: string): string {
  return `${value.slice(0, start)}${text}${value.slice(end)}`
}

function renderedCall(call: CatalogueCall): string {
  if (call.kind === 'variable' || call.args.length === 0) return call.name
  return `${call.name}(${call.args.join(', ')})`
}

const PLACEHOLDER = 'value'

/**
 * Insert a catalogue name at the caret.
 * Right after an expression inside `{{ }}`, a filter becomes ` | name(args)`.
 * Anywhere else it becomes a new `{{ … }}`, with `value` selected when a filter needs an input.
 */
export function insertCatalogueCall(
  value: string,
  caret: number,
  call: CatalogueCall,
): CatalogueInsertion {
  const at = clampCaret(value, caret)
  const rendered = renderedCall(call)
  const open = openExpression(value, at)
  if (call.kind === 'filter' && open >= 0) return insertFilter(value, at, open, rendered)
  if (open >= 0) {
    return {
      value: splice(value, at, at, rendered),
      cursor: at + rendered.length,
      select: null,
    }
  }
  const token = call.kind === 'filter' ? `{{ ${PLACEHOLDER} | ${rendered} }}` : `{{ ${rendered} }}`
  const next = splice(value, at, at, token)
  if (call.kind !== 'filter') {
    return { value: next, cursor: at + token.length, select: null }
  }
  const selectStart = at + 3
  return {
    value: next,
    cursor: selectStart + PLACEHOLDER.length,
    select: { start: selectStart, end: selectStart + PLACEHOLDER.length },
  }
}

function insertFilter(
  value: string,
  at: number,
  open: number,
  rendered: string,
): CatalogueInsertion {
  const inner = value.slice(open + 2, at)
  const pipe = lastUnquotedPipe(inner)
  if (pipe >= 0) {
    const pipeAt = open + 2 + pipe
    const from = pipeAt > 0 && value[pipeAt - 1] === ' ' ? pipeAt - 1 : pipeAt
    const text = ` | ${rendered}`
    return {
      value: splice(value, from, at, text),
      cursor: from + text.length,
      select: null,
    }
  }
  if (inner.trim().length > 0) {
    const text = ` | ${rendered}`
    return {
      value: splice(value, at, at, text),
      cursor: at + text.length,
      select: null,
    }
  }
  const inserted = ` ${PLACEHOLDER} | ${rendered}`
  const next = splice(value, open + 2, at, inserted)
  const selectStart = open + 3
  return {
    value: next,
    cursor: selectStart + PLACEHOLDER.length,
    select: { start: selectStart, end: selectStart + PLACEHOLDER.length },
  }
}

export function formatCatalogueArg(type: 'string' | 'number' | 'boolean', raw: string): string {
  if (type === 'number') {
    const trimmed = raw.trim()
    return trimmed === '' ? '0' : trimmed
  }
  if (type === 'boolean') return raw === 'true' ? 'true' : 'false'
  return `'${raw.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

interface FormattedArg {
  readonly omit: boolean
  readonly text: string
}

/** Positional arguments for a catalogue call. Trailing untouched optionals are left off. */
export function formatCatalogueArgs(
  params: readonly DeviceTemplateParam[],
  raw: Readonly<Record<string, string>>,
): readonly string[] {
  const formatted: FormattedArg[] = params.map((item) => formatOneArg(item, raw[item.name]))
  let end = formatted.length
  while (end > 0 && formatted[end - 1]?.omit === true) end -= 1
  return formatted.slice(0, end).map((item) => item.text)
}

function formatOneArg(item: DeviceTemplateParam, text: string | undefined): FormattedArg {
  const empty = text === undefined || text.trim() === ''
  if (empty && item.optional) return { omit: true, text: '' }
  return { omit: false, text: formatCatalogueArg(item.type, text ?? '') }
}

export interface TemplateAliasOption {
  readonly alias: string
  readonly label: string
}

export interface TemplateFieldOption {
  readonly path: string
  readonly kind: string
}

export interface TemplateSuggestion {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly replacement: string
}

export interface TemplateSuggestionInput {
  readonly aliases: readonly TemplateAliasOption[]
  readonly fields: readonly TemplateFieldOption[]
  readonly includeCamera: boolean
  readonly entries: readonly DeviceTemplateCatalogueEntry[]
  readonly cameraValues: readonly string[]
  readonly rootVariables: readonly string[]
  /** The unit of the piped field, when the editor knows it; narrows `units-of-field`. */
  readonly fieldUnit?: string
}

function matchesPrefix(label: string, prefix: string): boolean {
  return label.toLowerCase().startsWith(prefix.toLowerCase())
}

/** What Ctrl+Space (and `{{` / `|` / `alias.`) offers at this caret. */
export function templateSuggestions(
  ctx: TemplateCaretContext,
  input: TemplateSuggestionInput,
): readonly TemplateSuggestion[] {
  if (ctx.kind === 'none') return []
  if (ctx.kind === 'expression') return expressionSuggestions(ctx.prefix, input)
  if (ctx.kind === 'field') return fieldSuggestions(ctx, input)
  if (ctx.kind === 'argument') return argumentSuggestions(ctx, input)
  return input.entries
    .filter((item) => item.kind !== 'variable' && matchesPrefix(item.name, ctx.prefix))
    .map((item) => ({
      id: `fn:${item.name}`,
      label: item.name,
      detail: item.category,
      replacement: suggestionReplacement(item),
    }))
}

function argumentSuggestions(
  ctx: Extract<TemplateCaretContext, { kind: 'argument' }>,
  input: TemplateSuggestionInput,
): readonly TemplateSuggestion[] {
  const item = input.entries.find((e) => e.name === ctx.filter)
  const param = item?.params[ctx.index]
  if (param === undefined) return []
  const needle = ctx.typed.trim().toLowerCase()
  const rows: TemplateSuggestion[] = []
  for (const group of deviceTemplateParamChoices(param.values, input.fieldUnit)) {
    for (const choice of group.choices) {
      if (needle !== '' && !choice.value.toLowerCase().startsWith(needle)) continue
      rows.push({
        id: `arg:${ctx.filter}.${param.name}:${choice.value}`,
        label: choice.value,
        detail: choice.labelKey === undefined ? (group.group ?? '') : choice.labelKey,
        replacement: formatCatalogueArg(param.type, choice.value),
      })
    }
  }
  return rows
}

function suggestionReplacement(item: DeviceTemplateCatalogueEntry): string {
  if (item.kind === 'variable') return item.name
  const args = formatCatalogueArgs(item.params, {})
  return args.length === 0 ? item.name : `${item.name}(${args.join(', ')})`
}

function expressionSuggestions(
  prefix: string,
  input: TemplateSuggestionInput,
): readonly TemplateSuggestion[] {
  const variables = input.rootVariables.filter((name) => name !== 'camera' || input.includeCamera)
  const aliasRows: TemplateSuggestion[] = input.aliases
    .filter((item) => matchesPrefix(item.alias, prefix))
    .map((item) => ({
      id: `alias:${item.alias}`,
      label: item.alias,
      detail: item.label,
      replacement: item.alias,
    }))
  const variableRows: TemplateSuggestion[] = variables
    .filter(
      (name) => matchesPrefix(name, prefix) && !input.aliases.some((item) => item.alias === name),
    )
    .map((name) => ({
      id: `var:${name}`,
      label: name,
      detail: 'variable',
      replacement: name,
    }))
  return [...aliasRows, ...variableRows]
}

function fieldSuggestions(
  ctx: Extract<TemplateCaretContext, { kind: 'field' }>,
  input: TemplateSuggestionInput,
): readonly TemplateSuggestion[] {
  const paths =
    ctx.alias === 'camera'
      ? [...input.fields.map((item) => item.path), ...input.cameraValues]
      : input.fields.map((item) => item.path)
  const unique = [...new Set(paths)]
  return unique
    .filter((path) => matchesPrefix(path, ctx.prefix))
    .map((path) => ({
      id: `field:${ctx.alias}.${path}`,
      label: path,
      detail: ctx.alias,
      replacement: path,
    }))
}

/** Replace the prefix at the caret with the chosen suggestion. */
export function applyTemplateSuggestion(
  value: string,
  caret: number,
  ctx: TemplateCaretContext,
  replacement: string,
): CatalogueInsertion {
  const at = clampCaret(value, caret)
  const prefix = ctx.kind === 'none' ? '' : ctx.prefix
  const from = Math.max(0, at - prefix.length)
  // A quote the operator already closed after the caret (`unit('|')`) is part of the literal.
  const to = ctx.kind === 'argument' && ctx.quote !== null && value[at] === ctx.quote ? at + 1 : at
  return {
    value: splice(value, from, to, replacement),
    cursor: from + replacement.length,
    select: null,
  }
}
