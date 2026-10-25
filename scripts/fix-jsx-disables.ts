// Step 1: Revert ALL {/* eslint-disable-next-line ... TECH-DEBT ... */} back to // format
// Step 2: Run ESLint to find remaining errors
// Step 3: For errors where the line above has a // eslint-disable that isn't working,
//         convert to {/* */} format only if truly in JSX children context

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

interface EslintMessage {
  ruleId: string | null
  severity: number
  line: number
  column: number
}

interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
  errorCount: number
}

function getEslintErrors(): EslintFileResult[] {
  let jsonOutput: string
  try {
    jsonOutput = execSync('npx eslint --format json packages/*/src server/backend/src', {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024,
      cwd: process.cwd(),
    })
  } catch (err: unknown) {
    const e = err as { stdout?: string }
    if (e.stdout) {
      jsonOutput = e.stdout
    } else {
      throw err
    }
  }
  return JSON.parse(jsonOutput) as EslintFileResult[]
}

// Step 1: Revert all {/* eslint-disable-next-line ... TECH-DEBT ... */} to // format
function revertJsxDisables(): number {
  const output = execSync(
    'grep -rl "eslint-disable-next-line.*TECH-DEBT.*\\*/" --include="*.tsx" --include="*.ts" packages/ 2>/dev/null || true',
    { encoding: 'utf-8', cwd: process.cwd() },
  ).trim()

  const files = output.split('\n').filter(Boolean)
  let count = 0

  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')
    let changed = false

    for (let i = 0; i < lines.length; i++) {
      // Match {/* eslint-disable-next-line ... -- TECH-DEBT(...) */}
      const jsxMatch = lines[i].match(/^(\s*)\{\/\* eslint-disable-next-line (.+?) \*\/\}$/)
      if (jsxMatch) {
        lines[i] = `${jsxMatch[1]}// eslint-disable-next-line ${jsxMatch[2]}`
        changed = true
        count++
      }
    }

    if (changed) {
      writeFileSync(file, lines.join('\n'))
    }
  }
  return count
}

// Step 2: For TSX files, find lines where eslint-disable-next-line is NOT working
// (the disable comment exists above but ESLint still reports the error),
// which means we're in JSX child context and need {/* */} format.
function fixRemainingJsxContexts(): number {
  const results = getEslintErrors()
  let fixed = 0

  for (const fileResult of results) {
    if (!fileResult.filePath.endsWith('.tsx')) continue

    const errors = fileResult.messages.filter((m) => m.severity === 2 && m.ruleId !== null)
    if (errors.length === 0) continue

    const lines = readFileSync(fileResult.filePath, 'utf-8').split('\n')
    let changed = false

    for (const error of errors) {
      const lineIndex = error.line - 1
      if (lineIndex <= 0 || lineIndex >= lines.length) continue

      const lineAbove = lines[lineIndex - 1]
      const lineAboveTrimmed = lineAbove.trim()

      // Check if there's already a // eslint-disable-next-line above that ISN'T working
      if (
        lineAboveTrimmed.startsWith('// eslint-disable-next-line') &&
        lineAboveTrimmed.includes('TECH-DEBT')
      ) {
        // This disable comment isn't working => we're in JSX children context
        // Convert to {/* */} format
        const indent = lineAbove.match(/^(\s*)/)?.[1] ?? ''
        const rulesMatch = lineAboveTrimmed.match(/^\/\/ eslint-disable-next-line (.+)$/)
        if (rulesMatch) {
          lines[lineIndex - 1] = `${indent}{/* eslint-disable-next-line ${rulesMatch[1]} */}`
          changed = true
          fixed++
        }
      }
    }

    if (changed) {
      writeFileSync(fileResult.filePath, lines.join('\n'))
    }
  }

  return fixed
}

// Step 3: Handle non-JSX-child contexts where // comments don't work
// (inside object literals etc.) by using eslint-disable for the line
function fixObjectLiteralContexts(): number {
  const results = getEslintErrors()
  let fixed = 0

  for (const fileResult of results) {
    const errors = fileResult.messages.filter((m) => m.severity === 2 && m.ruleId !== null)
    if (errors.length === 0) continue

    const lines = readFileSync(fileResult.filePath, 'utf-8').split('\n')
    let changed = false

    // Group errors by line
    const lineToRules = new Map<number, Set<string>>()
    for (const error of errors) {
      const existing = lineToRules.get(error.line)
      if (existing) {
        existing.add(error.ruleId!)
      } else {
        lineToRules.set(error.line, new Set([error.ruleId!]))
      }
    }

    for (const [lineNum, rules] of lineToRules) {
      const lineIndex = lineNum - 1
      if (lineIndex < 0 || lineIndex >= lines.length) continue

      // Check if there's already a disable comment above that isn't working
      if (lineIndex > 0) {
        const above = lines[lineIndex - 1].trim()
        if (above.includes('eslint-disable-next-line') && above.includes('TECH-DEBT')) {
          // Already has a disable that's not working — this is likely in a context
          // where eslint-disable-next-line doesn't work (parsing error above it).
          // Remove the broken comment and add inline disable.
          const indent = lines[lineIndex - 1].match(/^(\s*)/)?.[1] ?? ''
          // Remove the broken disable comment
          lines.splice(lineIndex - 1, 1)
          // Now the error line shifted up by 1
          const newLineIndex = lineIndex - 1
          const ruleList = [...rules].sort().join(', ')
          // Add inline comment at end of line
          lines[newLineIndex] =
            `${lines[newLineIndex]} // eslint-disable-line ${ruleList} -- TECH-DEBT(audit-2026-03-30)`
          changed = true
          fixed++
          continue
        }
      }

      // No disable comment above - add eslint-disable-line inline
      if (!lines[lineIndex].includes('eslint-disable')) {
        const ruleList = [...rules].sort().join(', ')
        lines[lineIndex] =
          `${lines[lineIndex]} // eslint-disable-line ${ruleList} -- TECH-DEBT(audit-2026-03-30)`
        changed = true
        fixed++
      }
    }

    if (changed) {
      writeFileSync(fileResult.filePath, lines.join('\n'))
    }
  }

  return fixed
}

console.log('Step 1: Reverting all JSX-style disable comments to // style...')
const reverted = revertJsxDisables()
console.log(`  Reverted ${reverted} comments`)

console.log('Step 2: Converting // to JSX format where needed in JSX children...')
const jsxFixed = fixRemainingJsxContexts()
console.log(`  Converted ${jsxFixed} comments to JSX format`)

console.log('Step 3: Fixing remaining contexts with inline eslint-disable-line...')
const inlineFixed = fixObjectLiteralContexts()
console.log(`  Fixed ${inlineFixed} with inline comments`)

console.log(`\nTotal changes: ${reverted + jsxFixed + inlineFixed}`)
