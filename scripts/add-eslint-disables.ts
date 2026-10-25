import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

interface EslintMessage {
  ruleId: string | null
  severity: number
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
  errorCount: number
}

/**
 * Heuristic to detect if a line is inside JSX context in a TSX file.
 * Checks whether the line (trimmed) starts with JSX-like patterns.
 */
function isLikelyJsxContext(lines: readonly string[], lineIndex: number): boolean {
  const line = lines[lineIndex].trim()
  // Lines starting with { or < inside JSX
  if (line.startsWith('{') || line.startsWith('<') || line.startsWith('/>')) return true
  // Lines that are JSX attributes (e.g. trpc={...})
  if (/^[a-zA-Z]+=\{/.test(line)) return true

  // Walk up to find enclosing context
  for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 20); i--) {
    const prev = lines[i].trim()
    // If we hit a return ( or => ( pattern, we're probably in JSX
    if (/return\s*\(/.test(prev) || /=>\s*\(/.test(prev)) return true
    // If we hit a function/const/let/var/class declaration, we're not in JSX
    if (/^(function |const |let |var |class |interface |type |import |export )/.test(prev))
      return false
  }
  return false
}

function formatDisableComment(indent: string, ruleList: string, isJsx: boolean): string {
  if (isJsx) {
    return `${indent}{/* eslint-disable-next-line ${ruleList} -- TECH-DEBT(audit-2026-03-30) */}`
  }
  return `${indent}// eslint-disable-next-line ${ruleList} -- TECH-DEBT(audit-2026-03-30)`
}

function run(): void {
  console.log('Running ESLint with JSON output...')

  let jsonOutput: string
  try {
    jsonOutput = execSync('npx eslint --format json packages/*/src server/backend/src', {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024,
      cwd: process.cwd(),
    })
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    if (e.stdout) {
      jsonOutput = e.stdout
    } else {
      console.error('ESLint failed without output:', e.stderr)
      process.exit(1)
    }
  }

  let results: EslintFileResult[]
  try {
    results = JSON.parse(jsonOutput) as EslintFileResult[]
  } catch {
    console.error('Failed to parse ESLint JSON output')
    console.error('First 500 chars:', jsonOutput.slice(0, 500))
    process.exit(1)
  }

  let totalAdded = 0

  for (const fileResult of results) {
    const errors = fileResult.messages.filter((m) => m.severity === 2 && m.ruleId !== null)

    if (errors.length === 0) continue

    const isTsx = fileResult.filePath.endsWith('.tsx')

    // Group by line number
    const lineToRules = new Map<number, Set<string>>()
    for (const error of errors) {
      const existing = lineToRules.get(error.line)
      if (existing) {
        existing.add(error.ruleId!)
      } else {
        lineToRules.set(error.line, new Set([error.ruleId!]))
      }
    }

    const lines = readFileSync(fileResult.filePath, 'utf-8').split('\n')

    // Process lines in reverse order to preserve line numbers
    const sortedLineNumbers = [...lineToRules.keys()].sort((a, b) => b - a)

    for (const lineNum of sortedLineNumbers) {
      const rules = lineToRules.get(lineNum)!
      const lineIndex = lineNum - 1

      if (lineIndex < 0 || lineIndex >= lines.length) continue

      const jsxContext = isTsx && isLikelyJsxContext(lines, lineIndex)

      // Check if the line above already has an eslint-disable comment
      if (lineIndex > 0) {
        const lineAbove = lines[lineIndex - 1].trim()
        const hasDisableAbove =
          lineAbove.includes('eslint-disable-next-line') || lineAbove.includes('eslint-disable ')

        if (hasDisableAbove) {
          // Extract existing rules from the disable comment (both // and {/* */} formats)
          const matchJs = lineAbove.match(
            /eslint-disable-next-line\s+(.+?)(?:\s+--\s+.*)?(?:\s*\*\/\})?$/,
          )
          if (matchJs) {
            const existingRules = new Set(matchJs[1].split(',').map((r) => r.trim()))
            let merged = false
            for (const rule of rules) {
              if (!existingRules.has(rule)) {
                existingRules.add(rule)
                merged = true
              }
            }
            if (merged) {
              const indent = lines[lineIndex - 1].match(/^(\s*)/)?.[1] ?? ''
              const allRules = [...existingRules].sort().join(', ')
              lines[lineIndex - 1] = formatDisableComment(indent, allRules, jsxContext)
              totalAdded++
            }
          }
          continue
        }
      }

      // Check if the current line itself has an inline eslint-disable
      if (lines[lineIndex].includes('eslint-disable')) continue

      const indent = lines[lineIndex].match(/^(\s*)/)?.[1] ?? ''
      const ruleList = [...rules].sort().join(', ')
      const comment = formatDisableComment(indent, ruleList, jsxContext)

      lines.splice(lineIndex, 0, comment)
      totalAdded++
    }

    writeFileSync(fileResult.filePath, lines.join('\n'))
  }

  console.log(`Added ${totalAdded} eslint-disable comments.`)
}

run()
