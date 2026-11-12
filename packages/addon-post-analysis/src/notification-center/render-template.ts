/**
 * The ONE `{{var}}` renderer of the notification centre.
 *
 * Lifted out of `dispatcher.ts` VERBATIM — same regex, same missing-var rule,
 * same null-for-blank answer — for one reason only: the text catalog renders
 * with it, and the dispatcher renders with the catalog. Leaving it in the
 * dispatcher would make that an import cycle. `dispatcher.ts` re-exports it, so
 * every existing importer (`timelapse-delivery`, the specs) is unchanged.
 *
 * Two properties everything above this file relies on:
 *
 *  - **Single pass.** `String.replace` never re-scans what a replacement
 *    inserted, so a variable whose VALUE contains `{{…}}` is injected verbatim.
 *    That is the depth bound: the catalog renders its composite fragments
 *    FIRST, hands them in as plain strings, and no second substitution round
 *    can exist.
 *  - **A missing name renders EMPTY**, never the braces. A notification with
 *    `{{zone}}` printed on it is worse than one with a gap.
 */

/**
 * The ONE placeholder grammar. `renderTemplate` substitutes what it matches and
 * {@link templatePlaceholders} lists it; a second regex here would be a legend
 * that disagrees with the renderer about what a variable is, which is the
 * failure mode where an editor advertises `{{ device }}` as unsupported and the
 * notification prints the camera anyway.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g

/**
 * A device value that reads `{{ zone }}` is DATA (D1021), but it lands inside
 * the template text the `{{var}}` pass is about to scan. The device pass
 * escapes `{{` and `{%` to these private-use characters so the scan cannot see
 * them, and `renderTemplate` — the one renderer every text goes through —
 * restores them as the literal braces they were.
 */
const LITERAL_OPEN_BRACES = '\uE010'
const LITERAL_OPEN_BLOCK = '\uE011'

/** Hide `{{` and `{%` of rendered device text from the `{{var}}` pass. */
export function escapeLiteralMarkup(text: string): string {
  return text.replaceAll('{{', LITERAL_OPEN_BRACES).replaceAll('{%', LITERAL_OPEN_BLOCK)
}

function restoreLiteralMarkup(text: string): string {
  return text.replaceAll(LITERAL_OPEN_BRACES, '{{').replaceAll(LITERAL_OPEN_BLOCK, '{%')
}

/**
 * Names that were renamed and still resolve at render time, mapped to the name
 * that replaced them. `{{camera}}` became `{{device}}` (a rule on an appliance
 * names that device, not a camera); a template written by an older client still
 * prints the right name. An alias is NOT declared in the catalog and no picker
 * offers it: the stored rules are rewritten by the `pipeline-analytics` template
 * migration, and this table only covers a client that has not updated yet.
 */
export const NC_DEPRECATED_TEMPLATE_VARS: Readonly<Record<string, string>> = {
  camera: 'device',
}

/**
 * `{{deviceLabel}}` is the name plus its type. A producer that only stored the
 * bare name (or a template rendered before the label was computed) still names
 * the device: the label falls back to `{{deviceName}}`. A computed label is
 * present in the map and wins.
 */
function templateVar(name: string, vars: Readonly<Record<string, string>>): string {
  const current = vars[name]
  if (current !== undefined) return current
  if (name === 'deviceLabel') {
    const bare = vars['deviceName']
    if (bare !== undefined) return bare
  }
  const renamed = NC_DEPRECATED_TEMPLATE_VARS[name]
  return (renamed !== undefined ? vars[renamed] : undefined) ?? ''
}

/** The deprecated names a template still uses, in order of first appearance. */
export function deprecatedPlaceholders(template: string | undefined): readonly string[] {
  if (template === undefined) return []
  return templatePlaceholders(template).filter((name) => name in NC_DEPRECATED_TEMPLATE_VARS)
}

/**
 * The variable names a template names, de-duplicated, in order of first
 * appearance.
 *
 * The catalog's edit surface renders this as the per-key legend: the operator
 * is rewriting a sentence whose variables are supplied by a producer he cannot
 * see, and the only honest source for that list is the SHIPPED text.
 */
export function templatePlaceholders(template: string): readonly string[] {
  const found: string[] = []
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1]
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * `{{var}}` substitution over a frozen variable map. An unknown name renders
 * EMPTY rather than leaving the braces on screen.
 *
 * Exported so the timelapse producer renders its title/body with the SAME
 * vocabulary and the same missing-var rule. A second `{{}}` renderer in this
 * package would be free to disagree about exactly that.
 */
export function renderTemplate(
  template: string | undefined,
  vars: Readonly<Record<string, string>>,
  options?: RenderTemplateOptions,
): string | null {
  if (template === undefined || template.trim().length === 0) return null
  const substituted = template.replace(PLACEHOLDER_PATTERN, (_m, name: string) =>
    templateVar(name, vars),
  )
  return options?.keepLiteralHeld === true ? substituted : restoreLiteralMarkup(substituted)
}

export interface RenderTemplateOptions {
  /**
   * Leave the `{{` / `{%` that {@link escapeLiteralMarkup} hid still hidden. A producer
   * that enqueues a row for the dispatcher sets it: the dispatcher's device-template pass
   * must see only the operator's own markup, and its final `{{var}}` pass restores the rest.
   */
  readonly keepLiteralHeld?: boolean
}

/** Every value hidden from the dispatcher's device-template pass (see {@link RenderTemplateOptions}). */
export function holdVars(vars: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [name, escapeLiteralMarkup(value)]),
  )
}
