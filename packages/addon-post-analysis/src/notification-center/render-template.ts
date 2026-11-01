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
): string | null {
  if (template === undefined || template.trim().length === 0) return null
  return template.replace(PLACEHOLDER_PATTERN, (_m, name: string) => {
    const current = vars[name]
    if (current !== undefined) return current
    const renamed = NC_DEPRECATED_TEMPLATE_VARS[name]
    return (renamed !== undefined ? vars[renamed] : undefined) ?? ''
  })
}
