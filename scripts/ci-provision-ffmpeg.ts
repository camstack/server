#!/usr/bin/env tsx
/**
 * CI: provision the ffmpeg the PRODUCT runs, and put it where the suites spawn it.
 *
 * The recorded-segment demuxers, the recorder's fixture builders and the fMP4
 * splitter spawn a real ffmpeg. The product never runs the host's binary —
 * every node downloads one pinned build, and PATH is not on the list (D540) —
 * but the test runner had exactly that: whatever `apt-get install ffmpeg` gave
 * the runner template, which on `ci-runner` was **4.2.7**. In 4.2 Opus in
 * MP4 is "experimental, add '-strict -2'", so the Opus fallback transcoded to
 * nothing (`expected 0 to be greater than 50`) and every fixture-gated Opus
 * test skipped its body in silence, on every push from 2026-09-22 on. The
 * suites were grading a binary no node will ever run.
 *
 * So the runner gets the same build the same way: `ensureFfmpeg`, the code
 * path every node boots through, into a directory that outlives the checkout.
 * Then two things the job's later steps read:
 *
 *   - `$GITHUB_PATH` gets a shim directory whose `ffmpeg` IS that binary, so
 *     any spec or default that spawns `ffmpeg` by name gets it;
 *   - `$GITHUB_ENV` gets `CAMSTACK_FFMPEG_PATH`, the product's own override,
 *     for code and specs that resolve through it.
 *
 * Outside GitHub Actions (no `$GITHUB_PATH`) it prints the two exports instead,
 * so the same script serves a developer who wants the pinned build locally.
 *
 *   npx tsx scripts/ci-provision-ffmpeg.ts <dataDir>
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { FFMPEG_RELEASE, ensureFfmpeg } from '@camstack/types/node'

/** A logger that prints — this is a CI step, and its lines are the evidence. */
function consoleLogger(scope: string): IScopedLogger {
  const line = (level: string, message: string, extras?: LogExtras): void => {
    const meta = extras?.meta === undefined ? '' : ` ${JSON.stringify(extras.meta)}`
    process.stdout.write(`[${level}] ${scope}: ${message}${meta}\n`)
  }
  return {
    debug: (message, extras) => line('debug', message, extras),
    info: (message, extras) => line('info', message, extras),
    warn: (message, extras) => line('warn', message, extras),
    error: (message, extras) => line('error', message, extras),
    child: (childScope) => consoleLogger(childScope),
    withTags: () => consoleLogger(scope),
  }
}

/** Where the job's later steps pick the answer up, or null outside Actions. */
function actionsFile(name: 'GITHUB_PATH' | 'GITHUB_ENV'): string | null {
  const value = process.env[name]
  return value === undefined || value.length === 0 ? null : value
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === undefined || arg.length === 0) {
    process.stderr.write('usage: ci-provision-ffmpeg.ts <dataDir>\n')
    process.exit(2)
  }
  const dataDir = resolve(arg)
  mkdirSync(dataDir, { recursive: true })

  const ffmpegPath = await ensureFfmpeg(dataDir, consoleLogger('ci-ffmpeg'))

  // The shim: a directory whose `ffmpeg` is the pinned binary, for everything
  // that spawns it by name. Recreated every run so a release bump moves it.
  const shimDir = join(dataDir, 'bin')
  const shim = join(shimDir, 'ffmpeg')
  mkdirSync(shimDir, { recursive: true })
  if (existsSync(shim)) rmSync(shim)
  symlinkSync(ffmpegPath, shim)

  process.stdout.write(`ffmpeg ${FFMPEG_RELEASE} at ${ffmpegPath} (shim ${shim})\n`)

  const pathFile = actionsFile('GITHUB_PATH')
  const envFile = actionsFile('GITHUB_ENV')
  if (pathFile !== null && envFile !== null) {
    appendFileSync(pathFile, `${shimDir}\n`)
    appendFileSync(envFile, `CAMSTACK_FFMPEG_PATH=${ffmpegPath}\n`)
    process.stdout.write(`exported: PATH+=${shimDir}, CAMSTACK_FFMPEG_PATH=${ffmpegPath}\n`)
    return
  }
  process.stdout.write(
    `export PATH="${shimDir}:$PATH"\nexport CAMSTACK_FFMPEG_PATH="${ffmpegPath}"\n`,
  )
  // Keep the symlink's parent visible in the message when this runs by hand.
  process.stdout.write(`(dataDir ${dirname(shimDir)})\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`ci-provision-ffmpeg: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
