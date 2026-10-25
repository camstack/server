import * as fs from 'node:fs'
import * as path from 'node:path'

export type TarballFetcher = (name: string, version: string, signal: AbortSignal) => Promise<Buffer>
export type ExtractFn = (tgz: Buffer, destDir: string) => Promise<void>

interface StagingAreaDeps {
  readonly fetchTarball: TarballFetcher
  readonly extract: ExtractFn
}

interface FetchAndStageInput {
  readonly jobId: string
  readonly name: string
  readonly version: string
  readonly signal: AbortSignal
}

function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

interface PackageJsonVersion {
  version?: unknown
}

/** An exact semver — the only shape the staged package.json can be compared
 *  against literally. Anything else ('latest', 'beta', a range) is a dist-tag
 *  the FETCHER resolves; comparing the resolved version to the literal tag
 *  failed every tag-based update (30/30 on 2026-08-20). */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export class StagingArea {
  private readonly stagingDir: string
  private readonly deps: StagingAreaDeps

  constructor(stagingDir: string, deps: StagingAreaDeps) {
    this.stagingDir = stagingDir
    this.deps = deps
  }

  async fetchAndStage(
    input: FetchAndStageInput,
  ): Promise<{ stagedPath: string; resolvedVersion: string }> {
    const destDir = path.join(this.stagingDir, input.jobId, safeSegment(input.name))
    fs.rmSync(destDir, { recursive: true, force: true })

    const tgz = await this.deps.fetchTarball(input.name, input.version, input.signal)

    if (input.signal.aborted) {
      throw new Error('staging aborted after fetch')
    }

    await this.deps.extract(tgz, destDir)

    const raw = JSON.parse(
      fs.readFileSync(path.join(destDir, 'package.json'), 'utf-8'),
    ) as PackageJsonVersion
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      throw new Error(
        `staging validation failed: ${input.name} staged a package.json with no version`,
      )
    }
    if (EXACT_SEMVER.test(input.version) && raw.version !== input.version) {
      throw new Error(
        `staging validation failed: ${input.name} expected version ${input.version}, got ${raw.version}`,
      )
    }

    return { stagedPath: destDir, resolvedVersion: raw.version }
  }

  cleanup(jobId: string): void {
    fs.rmSync(path.join(this.stagingDir, jobId), { recursive: true, force: true })
  }

  /**
   * Remove every staged dir under `stagingDir`. Safe — and meant — to run once
   * at boot: `cleanup(jobId)` only fires when a lifecycle job finishes, so a
   * restart (or crash) that interrupts a job mid-flight leaves its
   * `<stagingDir>/<jobId>/` behind forever. At boot no job is in flight, so any
   * entry present is an orphan. Returns the number of orphan dirs removed.
   */
  sweepOrphans(): number {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.stagingDir)
    } catch {
      return 0 // staging dir not created yet → nothing to sweep
    }
    let removed = 0
    for (const name of entries) {
      try {
        fs.rmSync(path.join(this.stagingDir, name), { recursive: true, force: true })
        removed += 1
      } catch {
        // best-effort — a held inode / FUSE flake shouldn't fail boot
      }
    }
    return removed
  }
}
