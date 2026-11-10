#!/usr/bin/env node
/**
 * One JSON line per `verify:push` run, plus the stage summary it prints.
 *
 * The file is `~/.cache/camstack/verify-timings.jsonl` (override with
 * `VERIFY_TIMINGS_FILE`). It is outside the repo so parallel worktrees append
 * to the same history and git never sees it.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ANSI = /\u001b\[[0-9;]*m/g
const PART_NAMES = ['transform', 'setup', 'collect', 'tests', 'environment', 'prepare']

/**
 * @param {string} text
 * @returns {number}
 */
function toSeconds(value, unit) {
  return unit === 'ms' ? value / 1000 : value
}

/**
 * Vitest's closing `Duration` line. The parenthesised parts are summed across
 * files and workers, so collect can be larger than the wall clock.
 *
 * @param {string} text
 * @returns {{
 *   durationSeconds: number,
 *   transformSeconds: number | null,
 *   setupSeconds: number | null,
 *   collectSeconds: number | null,
 *   testsSeconds: number | null,
 *   environmentSeconds: number | null,
 *   prepareSeconds: number | null,
 * } | null}
 */
export function parseVitestSummary(text) {
  const line = text.replace(ANSI, '')
  const match = line.match(/Duration\s+([\d.]+)(ms|s)\b/)
  if (match === null) return null
  const parts = emptyParts()
  const paren = line.match(/\(([^)]*)\)/)
  if (paren !== null) fillParts(parts, paren[1])
  return { durationSeconds: toSeconds(Number(match[1]), match[2]), ...parts }
}

/**
 * @returns {Record<string, number | null>}
 */
function emptyParts() {
  /** @type {Record<string, number | null>} */
  const parts = {}
  for (const name of PART_NAMES) parts[`${name}Seconds`] = null
  return parts
}

/**
 * @param {Record<string, number | null>} parts
 * @param {string} body
 */
function fillParts(parts, body) {
  for (const hit of body.matchAll(/(\w+)\s+([\d.]+)(ms|s)/g)) {
    const key = `${hit[1]}Seconds`
    if (Object.hasOwn(parts, key)) parts[key] = toSeconds(Number(hit[2]), hit[3])
  }
}

/**
 * @param {number} seconds
 * @returns {number}
 */
function round3(seconds) {
  return Math.round(seconds * 1000) / 1000
}

/**
 * @param {object} input
 * @param {number} input.startMs
 * @param {number} input.endMs
 * @param {string} input.scope
 * @param {string} input.base
 * @param {'GREEN' | 'RED'} input.result
 * @param {number} input.cpus
 * @param {readonly (readonly [string, number])[]} input.stages
 * @param {readonly object[]} input.projects
 */
export function buildTimingRecord(input) {
  /** @type {Record<string, number>} */
  const stages = {}
  for (const [name, seconds] of input.stages) stages[name] = round3(seconds)
  return {
    start: new Date(input.startMs).toISOString(),
    end: new Date(input.endMs).toISOString(),
    scope: input.scope === '' ? 'none' : input.scope,
    base: input.base,
    result: input.result,
    cpus: input.cpus,
    stages,
    projects: input.projects.map(projectRow),
  }
}

/**
 * @param {object} project
 * @returns {{ project: string, lane: string, seconds: number, exitCode: number, collectSeconds: number | null, testsSeconds: number | null, vitestSeconds: number | null }}
 */
function projectRow(project) {
  return {
    project: String(project.project),
    lane: String(project.lane),
    seconds: round3(Number(project.seconds)),
    exitCode: Number(project.exitCode),
    collectSeconds: optionalSeconds(project.collectSeconds),
    testsSeconds: optionalSeconds(project.testsSeconds),
    vitestSeconds: optionalSeconds(project.vitestSeconds),
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return round3(value)
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function secondsLabel(seconds) {
  const rounded = Math.round(seconds * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text}s`
}

/**
 * @param {ReturnType<typeof buildTimingRecord>} record
 * @param {string} [file]
 * @returns {string}
 */
export function formatTimingSummary(record, file) {
  const total = (Date.parse(record.end) - Date.parse(record.start)) / 1000
  const lines = [
    `verify:push timing — ${secondsLabel(total)} total (scope ${record.scope}, ${record.result})`,
  ]
  for (const [name, seconds] of Object.entries(record.stages)) {
    lines.push(`  ${name.padEnd(16)} ${secondsLabel(seconds)}`)
  }
  if (record.projects.length > 0) lines.push(`  projects ${projectSummary(record.projects)}`)
  if (file !== undefined && file !== '') lines.push(`  file ${file}`)
  return lines.join('\n')
}

/**
 * @param {readonly { project: string, seconds: number }[]} projects
 * @returns {string}
 */
function projectSummary(projects) {
  const ranked = [...projects].sort((a, b) => b.seconds - a.seconds)
  const shown = ranked
    .slice(0, 8)
    .map((project) => `${project.project} ${secondsLabel(project.seconds)}`)
  const extra = ranked.length > 8 ? `, +${ranked.length - 8} more` : ''
  return `${shown.join(', ')}${extra}`
}

/**
 * @param {string} file
 * @param {ReturnType<typeof buildTimingRecord>} record
 */
export function appendTimingRecord(file, record) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--'))
      throw new Error(`verify-timing: unexpected ${arg}`)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`verify-timing: missing value for ${arg}`)
    out[arg.slice(2)] = value
    i += 1
  }
  return out
}

/**
 * @param {string} file
 * @returns {readonly (readonly [string, number])[]}
 */
function readStages(file) {
  const text = readFileSync(file, 'utf8')
  /** @type {[string, number][]} */
  const stages = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab === -1) throw new Error(`verify-timing: bad stage line ${line}`)
    stages.push([line.slice(0, tab), Number(line.slice(tab + 1))])
  }
  return stages
}

/**
 * @param {string} file
 * @returns {object[]}
 */
function readProjects(file) {
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text === '') return []
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('projects file is not a list')
    return parsed
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return []
    throw error
  }
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  const args = parseArgs(argv)
  const file = args.append
  if (file === undefined) throw new Error('verify-timing: --append is required')
  const record = buildTimingRecord({
    startMs: Number(args['start-ms']),
    endMs: Number(args['end-ms']),
    scope: args.scope ?? '',
    base: args.base ?? '',
    result: args.result === 'GREEN' ? 'GREEN' : 'RED',
    cpus: args.cpus === undefined ? cpus().length : Number(args.cpus),
    stages: args.stages === undefined ? [] : readStages(args.stages),
    projects: args.projects === undefined ? [] : readProjects(args.projects),
  })
  appendTimingRecord(file, record)
  process.stdout.write(`${formatTimingSummary(record, file)}\n`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
