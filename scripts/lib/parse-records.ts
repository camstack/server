/**
 * Static reading of record kinds (D881) for the guards: where kinds are
 * declared (`defineRecordKinds({...})`, `defineEntryKind(name, {...})`), what
 * each spec says, and where a `where` is written against a kind.
 *
 * It reads syntax only - never evaluates an addon. The runtime half (the plan of
 * every promised statement) is `check-records-index-served`.
 */
import ts from 'typescript'

export interface KindSpecScan {
  readonly file: string
  readonly kind: string
  /** The property names written in the spec object literal. */
  readonly keys: ReadonlySet<string>
  /** `entry` kinds get class / writeTrigger / retention from `defineEntryKind`. */
  readonly isEntry: boolean
  /** Fields of each literal index; `null` when `indexes` is not a literal (the guards cannot read it). */
  readonly indexFields: readonly (readonly string[])[] | null
  readonly line: number
}

function propName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text
  }
  return null
}

function literalStrings(node: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(node)) return null
  const out: string[] = []
  for (const el of node.elements) {
    if (!ts.isStringLiteral(el) && !ts.isNoSubstitutionTemplateLiteral(el)) return null
    out.push(el.text)
  }
  return out
}

function indexFieldsOf(node: ts.Expression): readonly (readonly string[])[] | null {
  if (!ts.isArrayLiteralExpression(node)) return null
  const all: string[][] = []
  for (const el of node.elements) {
    if (!ts.isObjectLiteralExpression(el)) return null
    const fieldsProp = el.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && propName(p.name) === 'fields',
    )
    const fields = fieldsProp === undefined ? null : literalStrings(fieldsProp.initializer)
    if (fields === null) return null
    all.push(fields)
  }
  return all
}

function scanSpec(
  file: string,
  kind: string,
  spec: ts.ObjectLiteralExpression,
  isEntry: boolean,
  sf: ts.SourceFile,
): KindSpecScan {
  const keys = new Set<string>()
  let indexFields: readonly (readonly string[])[] | null = []
  for (const p of spec.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
    const name = propName(p.name)
    if (name === null) continue
    keys.add(name)
    if (name === 'indexes') {
      indexFields = ts.isPropertyAssignment(p) ? indexFieldsOf(p.initializer) : null
    }
  }
  const { line } = sf.getLineAndCharacterOfPosition(spec.getStart(sf))
  return { file, kind, keys, isEntry, indexFields, line: line + 1 }
}

/** Every kind spec written in one source file. */
export function scanKindSpecs(file: string, source: string): readonly KindSpecScan[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: KindSpecScan[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === 'defineRecordKinds') {
        const arg = node.arguments[0]
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
              const name = propName(p.name)
              if (name !== null) found.push(scanSpec(file, name, p.initializer, false, sf))
            }
          }
        }
      } else if (callee === 'defineEntryKind') {
        const [nameArg, specArg] = node.arguments
        if (
          nameArg !== undefined &&
          (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) &&
          specArg !== undefined &&
          ts.isObjectLiteralExpression(specArg)
        ) {
          found.push(scanSpec(file, nameArg.text, specArg, true, sf))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** What a kind spec must say to be classified (the `@durable` vocabulary, as keys). */
export const REQUIRED_SPEC_KEYS: readonly string[] = ['class', 'writeTrigger', 'retention']

/** A `where: { a: …, b: … }` written in a call to a records read or bounded delete. */
export interface WhereUse {
  readonly file: string
  readonly line: number
  readonly method: string
  readonly keys: readonly string[]
}

const WHERE_METHODS: ReadonlySet<string> = new Set(['query', 'count', 'aggregate', 'deleteWhere'])

/** Every object-literal `where` passed to `.query(` / `.count(` / `.aggregate(` / `.deleteWhere(`. */
export function scanWhereUses(file: string, source: string): readonly WhereUse[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: WhereUse[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WHERE_METHODS.has(node.expression.name.text)
    ) {
      const arg = node.arguments[0]
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p) && propName(p.name) === 'where') {
            if (ts.isObjectLiteralExpression(p.initializer)) {
              const keys: string[] = []
              for (const w of p.initializer.properties) {
                if (ts.isPropertyAssignment(w) || ts.isShorthandPropertyAssignment(w)) {
                  const k = propName(w.name)
                  if (k !== null) keys.push(k)
                }
              }
              const { line } = sf.getLineAndCharacterOfPosition(p.getStart(sf))
              found.push({ file, line: line + 1, method: node.expression.name.text, keys })
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** A kind spec that does not say what class of fact it holds (the check-durable-state-declared rule, for kinds). */
export interface UnclassifiedKind {
  readonly file: string
  readonly kind: string
  readonly line: number
  readonly missing: readonly string[]
}

/** Specs missing `class` / `writeTrigger` / `retention`. An entry kind gets all three from `defineEntryKind`. */
export function unclassifiedKinds(specs: readonly KindSpecScan[]): readonly UnclassifiedKind[] {
  return specs
    .filter((spec) => !spec.isEntry)
    .map((spec) => ({
      file: spec.file,
      kind: spec.kind,
      line: spec.line,
      missing: REQUIRED_SPEC_KEYS.filter((key) => !spec.keys.has(key)),
    }))
    .filter((u) => u.missing.length > 0)
}
