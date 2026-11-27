#!/usr/bin/env node
/**
 * What the previous `verify:push` of the same base learned, read from
 * `~/.cache/camstack/verify-timings.jsonl` (override with `VERIFY_TIMINGS_FILE`).
 *
 * The test stage starts the projects that failed last time first, so a fix that
 * did not work is seen in minutes instead of after the whole suite. The base is
 * the merge-base with origin/main: it stays the same across the runs of one
 * batch, and changes when main moves (then the history no longer applies).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function timingsFile(env) {
  const override = env.VERIFY_TIMINGS_FILE ?? ''
  return override === ''
    ? path.join(homedir(), '.cache', 'camstack', 'verify-timings.jsonl')
    : override
}

/**
 * The projects that exited non-zero in the newest record of `base` that ran
 * any test project. A record cut short before the tests (fail-fast) has no
 * projects and is skipped, so the earlier evidence is not lost.
 *
 * @param {string} text the jsonl file
 * @param {string} base
 * @returns {string[]}
 */
export function failedProjectsFromHistory(text, base) {
  if (base === '') return []
  const lines = text.split('\n').filter((line) => line !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const record = parseRecord(lines[i])
    if (record === null || record.base !== base) continue
    if (!Array.isArray(record.projects) || record.projects.length === 0) continue
    return record.projects
      .filter((row) => typeof row === 'object' && row !== null && row.exitCode !== 0)
      .map((row) => String(row.project))
  }
  return []
}

/**
 * @param {string | undefined} line
 * @returns {{ base?: unknown, projects?: unknown[] } | null}
 */
function parseRecord(line) {
  if (line === undefined) return null
  try {
    const parsed = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * The base comes from `VERIFY_BASE` (verify-push.sh exports it).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function previouslyFailedProjects(env) {
  const base = env.VERIFY_BASE ?? ''
  const file = timingsFile(env)
  if (base === '' || !existsSync(file)) return []
  try {
    return failedProjectsFromHistory(readFileSync(file, 'utf8'), base)
  } catch {
    return []
  }
}
