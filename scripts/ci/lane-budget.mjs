#!/usr/bin/env node
/**
 * How `verify:push` spends the machine when it is not CI.
 *
 * CI (`.github/workflows/ci.yml`) calls `test-affected.sh --shard` and stays
 * on the serial heavy lane: overlapping heavy vitest processes failed timing
 * specs on the shared runner. A developer machine is the opposite problem —
 * the same lane ran one package at a time on 4 of 12 cores and took ~25 min.
 * Locally the heavy and light lanes run together. The product of slots and
 * vitest workers never exceeds the CPU count.
 *
 * `VERIFY_LOCAL=1` forces this schedule even when `CI` is set.
 * `VERIFY_LOCAL=0` forces the serial CI schedule.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Median wall-clock seconds per project in the last ~80 `verify:push` runs
 * (2026-11-27, 12-core Mac, both lanes running, so contention is in the
 * numbers). Re-read `~/.cache/camstack/verify-timings.jsonl` when a package
 * moves. An absent name sorts first: a package this table does not know yet is
 * the one whose cost we have not measured, so it must not wait behind known
 * work.
 */
export const HEAVY_WEIGHT_SECONDS = {
  '@camstack/addon-admin-ui': 1008,
  '@camstack/server-framework': 483,
  '@camstack/addon-post-analysis': 446,
  '@camstack/ui-library': 299,
  '@camstack/addon-pipeline': 265,
  '@camstack/server': 221,
  '@camstack/types': 61,
  '@camstack/addon-pipeline-orchestrator': 55,
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function localLanesEnabled(env) {
  const force = env.VERIFY_LOCAL ?? ''
  if (force === '0' || force === 'false') return false
  if (force === '1' || force === 'true') return true
  const ci = env.CI ?? ''
  return ci === '' || ci === '0' || ci === 'false'
}

/**
 * @param {readonly string[]} projects
 * @returns {string[]}
 */
export function orderLongestFirst(projects) {
  return [...projects].sort((a, b) => {
    const delta = weight(b) - weight(a)
    if (delta !== 0 && !Number.isNaN(delta)) return delta
    if (a < b) return -1
    if (a > b) return 1
    return 0
  })
}

/**
 * Projects that failed in the previous run of this base first (longest first
 * among themselves), then the rest longest first. An unknown project keeps its
 * place at the front of its own group.
 *
 * @param {readonly string[]} projects
 * @param {readonly string[]} [failedBefore]
 * @returns {string[]}
 */
export function orderProjects(projects, failedBefore = []) {
  const failed = new Set(failedBefore)
  const again = projects.filter((name) => failed.has(name))
  const rest = projects.filter((name) => !failed.has(name))
  return [...orderLongestFirst(again), ...orderLongestFirst(rest)]
}

/**
 * @param {string} name
 * @returns {number}
 */
function weight(name) {
  const known = HEAVY_WEIGHT_SECONDS[name]
  return known === undefined ? Number.POSITIVE_INFINITY : known
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @returns {number | undefined}
 */
function envPositive(env, key) {
  const raw = env[key]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function orDefault(value, fallback) {
  return value === undefined ? fallback : value
}

/**
 * @param {object} input
 * @param {number} input.count
 * @param {number} input.parallelCap 0 means "as many slots as the cores allow"
 * @param {number} input.workerCap
 * @param {number} input.cores
 * @returns {{ parallel: number, workers: number }}
 */
function fitLane({ count, parallelCap, workerCap, cores }) {
  if (count === 0) return { parallel: 0, workers: 0 }
  const workersPrefer = Math.min(workerCap, cores)
  const cap = parallelCap > 0 ? parallelCap : Math.max(1, Math.floor(cores / workersPrefer))
  let parallel = Math.min(count, cap, cores)
  let workers = workersPrefer
  while (parallel * workers > cores && workers > 1) workers -= 1
  while (parallel * workers > cores && parallel > 1) parallel -= 1
  if (parallelCap === 0) {
    while (parallel < count && (parallel + 1) * workers <= cores) parallel += 1
  }
  return { parallel, workers }
}

/**
 * @param {object} input
 * @param {number} input.cpus
 * @param {number} input.heavyCount
 * @param {number} input.lightCount
 * @param {NodeJS.ProcessEnv} [input.env]
 * @returns {{ concurrent: boolean, heavyParallel: number, lightParallel: number, heavyWorkers: number, lightWorkers: number }}
 */
export function localLaneBudget({ cpus, heavyCount, lightCount, env = {} }) {
  const cores = Math.max(1, Math.floor(Number(cpus)) || 1)
  const heavyN = Math.max(0, Math.floor(heavyCount))
  const lightN = Math.max(0, Math.floor(lightCount))
  if (heavyN === 0 || lightN === 0) return aloneBudget(cores, heavyN, lightN, env)
  return bothBudget(cores, heavyN, lightN, env)
}

/**
 * @param {number} cores
 * @param {number} heavyN
 * @param {number} lightN
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrent: boolean, heavyParallel: number, lightParallel: number, heavyWorkers: number, lightWorkers: number }}
 */
function aloneBudget(cores, heavyN, lightN, env) {
  const heavy = fitLane({
    count: heavyN,
    parallelCap: orDefault(envPositive(env, 'VERIFY_HEAVY_PARALLEL'), 2),
    workerCap: orDefault(
      envPositive(env, 'VERIFY_HEAVY_WORKERS') ?? envPositive(env, 'VERIFY_VITEST_MAX_WORKERS'),
      4,
    ),
    cores,
  })
  const lightParallelEnv =
    envPositive(env, 'LIGHT_PARALLEL') ?? envPositive(env, 'VERIFY_LIGHT_PARALLEL')
  const light = fitLane({
    count: lightN,
    parallelCap: lightParallelEnv === undefined ? 0 : lightParallelEnv,
    workerCap: orDefault(
      envPositive(env, 'VERIFY_LIGHT_WORKERS') ?? envPositive(env, 'VERIFY_VITEST_MAX_WORKERS'),
      4,
    ),
    cores,
  })
  return {
    concurrent: false,
    heavyParallel: heavy.parallel,
    heavyWorkers: heavy.workers,
    lightParallel: light.parallel,
    lightWorkers: light.workers,
  }
}

/**
 * @param {number} cores
 * @param {number} heavyN
 * @param {number} lightN
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrent: boolean, heavyParallel: number, lightParallel: number, heavyWorkers: number, lightWorkers: number }}
 */
function bothBudget(cores, heavyN, lightN, env) {
  let heavyParallel = Math.min(
    orDefault(envPositive(env, 'VERIFY_HEAVY_PARALLEL'), 2),
    heavyN,
    cores,
  )
  let lightParallel = Math.min(
    orDefault(envPositive(env, 'LIGHT_PARALLEL') ?? envPositive(env, 'VERIFY_LIGHT_PARALLEL'), 2),
    lightN,
    cores,
  )
  let heavyWorkers = Math.min(heavyWorkerCap(env), cores)
  let lightWorkers = Math.min(orDefault(envPositive(env, 'VERIFY_LIGHT_WORKERS'), 2), cores)
  while (heavyParallel + lightParallel > cores) {
    if (lightParallel >= heavyParallel && lightParallel > 1) lightParallel -= 1
    else if (heavyParallel > 1) heavyParallel -= 1
    else break
  }
  if (heavyParallel + lightParallel > cores) return serialOnTinyMachine(cores, heavyN, lightN, env)
  while (heavyParallel * heavyWorkers + lightParallel * lightWorkers > cores) {
    if (heavyWorkers > lightWorkers && heavyWorkers > 1) heavyWorkers -= 1
    else if (lightWorkers > 1) lightWorkers -= 1
    else if (heavyWorkers > 1) heavyWorkers -= 1
    else break
  }
  return {
    concurrent: true,
    heavyParallel,
    lightParallel,
    heavyWorkers,
    lightWorkers,
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function heavyWorkerCap(env) {
  return orDefault(
    envPositive(env, 'VERIFY_HEAVY_WORKERS') ??
      envPositive(env, 'VERIFY_VITEST_MAX_WORKERS') ??
      envPositive(env, 'VITEST_MAX_WORKERS'),
    4,
  )
}

/**
 * One core cannot host both lanes. Each lane runs alone, then the other.
 *
 * @param {number} cores
 * @param {number} heavyN
 * @param {number} lightN
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ concurrent: boolean, heavyParallel: number, lightParallel: number, heavyWorkers: number, lightWorkers: number }}
 */
function serialOnTinyMachine(cores, heavyN, lightN, env) {
  const heavy = aloneBudget(cores, heavyN, 0, env)
  const light = aloneBudget(cores, 0, lightN, env)
  return {
    concurrent: false,
    heavyParallel: heavy.heavyParallel,
    heavyWorkers: heavy.heavyWorkers,
    lightParallel: light.lightParallel,
    lightWorkers: light.lightWorkers,
  }
}

/**
 * @param {object} input
 * @param {number} input.cpus
 * @param {readonly string[]} input.heavy
 * @param {readonly string[]} input.light
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {readonly string[]} [input.failedBefore] projects red in the previous run of this base
 */
export function lanePlan({ cpus, heavy, light, env = {}, failedBefore = [] }) {
  const budget = localLaneBudget({
    cpus,
    heavyCount: heavy.length,
    lightCount: light.length,
    env,
  })
  const failed = new Set(failedBefore)
  return {
    ...budget,
    cpus,
    heavy: orderProjects(heavy, failedBefore),
    light: [
      ...light.filter((name) => failed.has(name)),
      ...light.filter((name) => !failed.has(name)),
    ],
  }
}

/**
 * Vitest processes alive at once: one parent per slot plus its workers.
 * A serial plan (one core) only has one lane running.
 *
 * @param {{ concurrent: boolean, heavyParallel: number, lightParallel: number, heavyWorkers: number, lightWorkers: number }} budget
 * @returns {number}
 */
export function laneProcessCount(budget) {
  const heavy = budget.heavyParallel * (budget.heavyWorkers + 1)
  const light = budget.lightParallel * (budget.lightWorkers + 1)
  const atOnce = budget.concurrent ? heavy + light : Math.max(heavy, light)
  return Math.max(1, atOnce)
}

/**
 * Heap per process so the lanes fit in RAM with 8 GB left for the OS.
 * Capped at 2 GB: a 3 GB heap on every worker is what swapped the 36 GB Mac
 * (admin-ui 328 s → 926 s) when verify:push's NODE_OPTIONS was inherited.
 *
 * @param {{ totalBytes: number, processCount: number }} input
 * @returns {number} megabytes
 */
export function laneHeapMb({ totalBytes, processCount }) {
  const reserve = 8 * 1024 * 1024 * 1024
  const available = Math.max(512 * 1024 * 1024, totalBytes - reserve)
  const perProcess = Math.floor(available / Math.max(1, processCount) / (1024 * 1024))
  return Math.min(2048, Math.max(512, perProcess))
}

/**
 * @param {string | undefined} current
 * @param {number} heapMb
 * @returns {string}
 */
export function nodeOptionsWithHeap(current, heapMb) {
  const stripped = (current ?? '')
    .replace(/--max-old-space-size=\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const flag = `--max-old-space-size=${heapMb}`
  return stripped === '' ? flag : `${stripped} ${flag}`
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly && process.argv[2] === '--enabled') {
  process.exit(localLanesEnabled(process.env) ? 0 : 1)
}
