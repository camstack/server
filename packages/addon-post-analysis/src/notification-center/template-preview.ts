/**
 * `previewTemplate` — render a rule's draft title/body against EXAMPLE values,
 * so an operator sees `{{scope}}: {{count}}/{{capacity}}` become
 * `Cancello: 3/2` before saving the rule, not after the first real event.
 *
 * Pure with respect to the caller: it never sends anything, and the only
 * side-channel it reads is the live `NcTextCatalog` handed in, so a preview
 * always speaks the hub's CURRENT language and CURRENT overrides — the same
 * words a delivered notification would use.
 */
import {
  NC_TEMPLATE_VARS,
  isKnownTemplateVar,
  templateVarsFor,
  type NcTemplatePreview,
  type NcTemplatePreviewInput,
} from '@camstack/types'
import { ncClockText } from './clock-text.js'
import { renderTemplate, templatePlaceholders } from './render-template.js'
import type { NcTextCatalog } from './text-catalog.js'
import { ncDetectionSummary, ncInZonesText, ncOccupancyOp, ncSubjectText } from './text-compose.js'

/**
 * The instant `{{time}}` is previewed at — fixed, and in UTC, so the example
 * is the same on every host: "20:05" in Italian, "08:05 PM" in English.
 */
const PREVIEW_INSTANT_MS = Date.UTC(2026, 8, 24, 20, 5)
const PREVIEW_TIME_ZONE = 'UTC'

/**
 * The example map: every declared example, with the COMPOSITES rendered by the
 * real composers so the preview speaks the hub's language exactly as a
 * delivered notification would.
 */
function exampleVars(texts: NcTextCatalog): Readonly<Record<string, string>> {
  const plain = Object.fromEntries(
    NC_TEMPLATE_VARS.filter((d) => d.dynamic === undefined).map((d) => [d.name, d.example]),
  )
  return {
    ...plain,
    subject: ncSubjectText(texts, { className: 'person', label: 'Mario', labelKind: 'identity' }),
    inZones: ncInZonesText(texts, ['Cancello']),
    op: ncOccupancyOp(texts, true),
    // Through the SAME formatter every producer uses, so the preview shows the
    // shape a delivered `{{time}}` will have in this language.
    time: ncClockText(texts.language, PREVIEW_INSTANT_MS, PREVIEW_TIME_ZONE),
    detectionSummary: ncDetectionSummary(texts, [
      { className: 'person', count: 2 },
      { className: 'car', count: 1 },
    ]),
  }
}

const DYNAMIC_EXAMPLE = '3'

export function previewTemplate(
  texts: NcTextCatalog,
  input: NcTemplatePreviewInput,
): NcTemplatePreview {
  const ctx = input.context
  const allowed = new Set(templateVarsFor(ctx).map((d) => d.name))
  const examples = exampleVars(texts)
  const used = [input.template.title ?? '', input.template.body ?? ''].flatMap((t) => [
    ...templatePlaceholders(t),
  ])
  const unknown = [...new Set(used.filter((name) => !isKnownTemplateVar(name, ctx)))]
  const vars: Record<string, string> = {}
  for (const name of used) {
    if (!isKnownTemplateVar(name, ctx)) continue
    vars[name] = allowed.has(name) ? (examples[name] ?? '') : DYNAMIC_EXAMPLE
  }
  return {
    title: renderTemplate(input.template.title, vars),
    body: renderTemplate(input.template.body, vars),
    unknown,
  }
}
