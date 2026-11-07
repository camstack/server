/**
 * `{{camera}}` -> `{{device}}` in every stored notification template (D987, M3).
 *
 * A rule on an appliance or a sensor names that device, not a camera, so the
 * template variable was renamed. The templates an operator already saved say
 * `{{camera}}`; this migration rewrites them where they are stored:
 *
 *  - `notification-center:rules`: `template.title`, `template.body`
 *  - `notification-center:timelapse-rules`: `template.title`, `template.body`, `previewText`
 *  - `notification-center:texts`: every per-key override of every language
 *
 * It is a `procedure`, not a `plan`: rows of a record kind are written through the
 * records engine, which derives their indexed columns (the engine refuses a record
 * edit inside a plan). It is idempotent: a row without the old name is not touched,
 * so a rerun finds nothing to do and reports `already-done`.
 */
import type { MigrationProcedureResult, RecordKindHandle, RecordRow } from '@camstack/types'
import type { RuleBody, TextsBody, TimelapseRuleBody } from '../notification-center/record-kinds.js'

/** The three kinds the migration reads and writes. */
export interface NcTemplateMigrationPorts {
  readonly rules: RecordKindHandle<RuleBody>
  readonly timelapseRules: RecordKindHandle<TimelapseRuleBody>
  readonly texts: RecordKindHandle<TextsBody>
}

/** `{{camera}}` and `{{ camera }}`: the whitespace the renderer allows is kept as written. */
const OLD_VARIABLE = /\{\{(\s*)camera(\s*)\}\}/g

/** The template text with the variable renamed; the same string when it names none. */
export function renameDeviceVariable(text: string): string {
  return text.replace(OLD_VARIABLE, '{{$1device$2}}')
}

interface TemplateFields {
  title?: string | undefined
  body?: string | undefined
}

/** A `{ title, body }` template with both fields renamed; `null` when neither changed. */
function renamedTemplate<T extends TemplateFields>(template: T | undefined): T | null {
  if (template === undefined) return null
  const title = template.title === undefined ? undefined : renameDeviceVariable(template.title)
  const body = template.body === undefined ? undefined : renameDeviceVariable(template.body)
  if (title === template.title && body === template.body) return null
  return {
    ...template,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}

export function renamedRule(data: RuleBody): RuleBody | null {
  const template = renamedTemplate(data.template)
  return template === null ? null : { ...data, template }
}

export function renamedTimelapseRule(data: TimelapseRuleBody): TimelapseRuleBody | null {
  const template = renamedTemplate(data.template)
  const previewText =
    data.previewText === undefined ? undefined : renameDeviceVariable(data.previewText)
  const previewChanged = previewText !== data.previewText
  if (template === null && !previewChanged) return null
  return {
    ...data,
    ...(template !== null ? { template } : {}),
    ...(previewChanged && previewText !== undefined ? { previewText } : {}),
  }
}

export function renamedTexts(data: TextsBody): TextsBody | null {
  let changed = false
  const overrides: TextsBody['overrides'] = Object.fromEntries(
    Object.entries(data.overrides).map(([language, table]) => [
      language,
      Object.fromEntries(
        Object.entries(table).map(([key, text]) => {
          const next = renameDeviceVariable(text)
          if (next !== text) changed = true
          return [key, next]
        }),
      ),
    ]),
  )
  return changed ? { ...data, overrides } : null
}

const PAGE = 500

/** Every row of a kind, page by page. */
export async function allRows<T>(kind: RecordKindHandle<T>): Promise<readonly RecordRow<T>[]> {
  const rows: RecordRow<T>[] = []
  let cursor: string | undefined
  do {
    const page = await kind.query({
      limit: PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    rows.push(...page.records)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return rows
}

/** Rewrite the rows of one kind that carry the old name; returns how many were written. */
export async function rewriteKind<T>(
  kind: RecordKindHandle<T>,
  rewrite: (data: T) => T | null,
): Promise<number> {
  let written = 0
  for (const row of await allRows(kind)) {
    const next = rewrite(row.data)
    if (next === null) continue
    // `ifRev`: a rule the operator saved since this row was read is not overwritten
    // with the older text; the migration fails and a retry reads the new row.
    await kind.put({ id: row.id, data: next }, { ifRev: row.rev })
    written += 1
  }
  return written
}

export async function migrateDeviceTemplateVariable(
  ports: NcTemplateMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rules = await rewriteKind(ports.rules, renamedRule)
  const timelapseRules = await rewriteKind(ports.timelapseRules, renamedTimelapseRule)
  const texts = await rewriteKind(ports.texts, renamedTexts)
  return {
    outcome: rules + timelapseRules + texts === 0 ? 'already-done' : 'done',
    summary: { rules, timelapseRules, texts },
  }
}
