// packages/system/src/builtins/composer/__tests__/composer-manifest.spec.ts
/**
 * The composer runs ALONE in its own runner (D2/D29): frame-free, low-crash,
 * and it OWNS devices (it declares them and serves their natives) with none of
 * the manifest signals the D29 guard classifies a provider by. Its
 * `execution.group: 'composer'` is therefore a group of ONE: this spec pins it
 * for the system package, and `scripts/check-runner-group-isolation.ts`
 * (`DEVICE_OWNING_BUILTINS`) refuses any addon in the repo that joins it (R6).
 * `CrashSupervisor` bounds it like every forked runner (D6), because it is
 * spawned like one.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { COMPOSER_RUNNER_ID, isIsolatedBuiltin, resolveRunnerId } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isRecord } from '../../shared/device-state-changed.js'

interface ManifestExecution {
  readonly isolate?: boolean
  readonly group?: string
}

interface ManifestEntry {
  readonly id: string
  readonly execution: ManifestExecution | undefined
  /** `execution.placement` as written — kept apart from `execution`, whose declared type narrows it. */
  readonly placement: unknown
  readonly capabilities: readonly string[]
}

function toEntry(raw: unknown): ManifestEntry | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return null
  const execution = raw['execution']
  const caps = raw['capabilities']
  return {
    id: raw['id'],
    execution: isRecord(execution)
      ? {
          isolate: execution['isolate'] === true,
          group: typeof execution['group'] === 'string' ? execution['group'] : undefined,
        }
      : undefined,
    placement: isRecord(execution) ? execution['placement'] : undefined,
    capabilities: Array.isArray(caps)
      ? caps.flatMap((c: unknown) =>
          isRecord(c) && typeof c['name'] === 'string' ? [c['name']] : [],
        )
      : [],
  }
}

/** Every `camstack.addons[]` entry of `packages/system/package.json`. */
function manifestEntries(): readonly ManifestEntry[] {
  const pkgPath = path.resolve(import.meta.dirname, '../../../../package.json')
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const camstack = isRecord(parsed) ? parsed['camstack'] : undefined
  const addons = isRecord(camstack) ? camstack['addons'] : undefined
  if (!Array.isArray(addons)) throw new Error('no camstack.addons')
  return addons.flatMap((a: unknown) => {
    const entry = toEntry(a)
    return entry === null ? [] : [entry]
  })
}

function composerEntry(): ManifestEntry {
  const entry = manifestEntries().find((e) => e.id === 'composer')
  if (entry === undefined) throw new Error('no composer entry')
  return entry
}

describe('the composer manifest entry', () => {
  it('is an isolated builtin in its own group, whose runner id the contract pins', () => {
    const entry = composerEntry()
    expect(isIsolatedBuiltin(entry)).toBe(true)
    expect(entry.execution?.group).toBe(COMPOSER_RUNNER_ID)
    expect(resolveRunnerId(entry, entry.id)).toBe(COMPOSER_RUNNER_ID)
  })
  it('is the ONLY member of its group: a device-owning builtin shares a runner with nobody (D29, R6)', () => {
    const members = manifestEntries()
      .filter((e) => e.execution?.group === COMPOSER_RUNNER_ID)
      .map((e) => e.id)
    expect(members).toEqual(['composer'])
  })
  it('is pinned hub-only: its declarations are cluster state, never inherited from a default', () => {
    expect(composerEntry().placement).toBe('hub-only')
  })
  it('declares only the composer cap', () => {
    expect(composerEntry().capabilities).toEqual(['composer'])
  })
})
