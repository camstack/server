/**
 * Provider settings help-text guard — a settings field explains only what an
 * operator cannot read off its label.
 *
 * A Reolink settings page once carried dozens of lines naming protocol
 * commands, channel ids and "pushed via cmd_id 45" notes: true, and of no use
 * to anyone configuring a camera, while the one sentence that mattered (this
 * unit is not obvious, this value must match the camera) sat among them. The
 * text that stays is for an AMBIGUOUS field (two that could be confused, a
 * unit that is not obvious, a value that must match something outside
 * CamStack) or an UNCOMMON / RISKY one (an advanced override, a setting that
 * breaks streaming if wrong). Everything else is the label said twice.
 *
 * Two rules, both on the English source of `packages/addon-provider-*`:
 *   - a `description` / `hint` / `help` string is at most
 *     `MAX_DESCRIPTION_CHARS` characters;
 *   - an `info` block's static `content` is at most `MAX_INFO_SENTENCES`
 *     sentences.
 *
 * A `${…}` hole counts as one character: the dynamic part is not prose.
 * A same-file `const NAME = '…'` is followed when a description names it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const MAX_DESCRIPTION_CHARS = 160
export const MAX_INFO_SENTENCES = 2

const HELP_PROPERTIES: ReadonlySet<string> = new Set(['description', 'hint', 'help'])

export interface HelpProblem {
  readonly line: number
  readonly message: string
}

/** The static prose of an expression: literals, concatenations, templates, same-file consts. */
function staticTexts(
  node: ts.Expression,
  consts: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string> = new Set(),
): readonly string[] {
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return staticTexts(node.expression, consts, seen)
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text]
    for (const span of node.templateSpans) parts.push('#', span.literal.text)
    return [parts.join('')]
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticTexts(node.left, consts, seen)
    const right = staticTexts(node.right, consts, seen)
    if (left.length === 1 && right.length === 1) return [`${left[0]}${right[0]}`]
    return [...left, ...right]
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...staticTexts(node.whenTrue, consts, seen),
      ...staticTexts(node.whenFalse, consts, seen),
    ]
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const target = consts.get(node.text)
    if (target) return staticTexts(target, consts, new Set([...seen, node.text]))
  }
  return []
}

/** Sentences in a text: a stop followed by a capital letter or the end. */
export function sentenceCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/).length
}

function isInfoBlock(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      p.name.getText() === 'type' &&
      ts.isStringLiteralLike(p.initializer) &&
      p.initializer.text === 'info',
  )
}

/** Every over-long description and over-wordy info block in one source file. */
export function helpProblems(fileName: string, source: string): readonly HelpProblem[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const consts = new Map<string, ts.Expression>()
  sf.forEachChild((statement) => {
    if (!ts.isVariableStatement(statement)) return
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer)
        consts.set(decl.name.text, decl.initializer)
    }
  })

  const problems: HelpProblem[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText()
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (HELP_PROPERTIES.has(name)) {
        for (const text of staticTexts(node.initializer, consts)) {
          if (text.length > MAX_DESCRIPTION_CHARS) {
            problems.push({
              line,
              message: `${name} is ${text.length} chars (max ${MAX_DESCRIPTION_CHARS}): "${text.slice(0, 60)}…"`,
            })
          }
        }
      } else if (
        name === 'content' &&
        ts.isObjectLiteralExpression(node.parent) &&
        isInfoBlock(node.parent)
      ) {
        for (const text of staticTexts(node.initializer, consts)) {
          const sentences = sentenceCount(text)
          if (sentences > MAX_INFO_SENTENCES) {
            problems.push({
              line,
              message: `info content has ${sentences} sentences (max ${MAX_INFO_SENTENCES}): "${text.slice(0, 60)}…"`,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return problems
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== '__tests__')
        sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry) && !/\.(spec|test|d)\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function main(): void {
  const root = process.cwd()
  const packagesDir = join(root, 'packages')
  const offenders: string[] = []
  for (const name of readdirSync(packagesDir)) {
    if (!name.startsWith('addon-provider-')) continue
    const src = join(packagesDir, name, 'src')
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of sourceFiles(src)) {
      for (const p of helpProblems(file, readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(root, file)}:${p.line}: ${p.message}`)
      }
    }
  }
  if (offenders.length > 0) {
    console.error('✘ a provider settings text says more than an operator needs:')
    for (const o of offenders) console.error(`    ${o}`)
    console.error(
      '  Keep a description only for an ambiguous field (unit, lookalike, a value that must match the\n' +
        '  camera) or a risky one, in one short sentence. Protocol commands, channel ids and "pushed via…"\n' +
        '  notes belong in code comments, not in the operator UI.',
    )
    process.exit(1)
  }
  console.log('✔ every provider settings description is short')
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
