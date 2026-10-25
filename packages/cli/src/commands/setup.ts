import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { parseArgs } from 'node:util'
import { FFMPEG_PATH_ENV } from '@camstack/types'

/**
 * What setup says about ffmpeg. It used to run `ffmpeg -version` off PATH and
 * tell the operator to `brew install ffmpeg` — but no node ever runs the
 * host's binary: each one downloads the same pinned build on first start
 * (D540). So there is nothing on PATH worth checking, and advice to install
 * one would only produce a binary nothing uses.
 */
export function describeFfmpegProvisioning(env: NodeJS.ProcessEnv): string {
  const override = env[FFMPEG_PATH_ENV]?.trim() ?? ''
  if (override.length > 0) {
    return `ffmpeg: ${FFMPEG_PATH_ENV}=${override} (operator override — used instead of the pinned build)`
  }
  return 'ffmpeg: the pinned build is downloaded by each node on first start — nothing to install'
}

export function getDefaultDataPath(): string {
  return path.join(process.cwd(), 'camstack-data')
}

export function runSetup(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      data: { type: 'string', short: 'd' },
    },
    strict: true,
    allowPositionals: false,
  })
  const dataPath = typeof values.data === 'string' ? values.data : getDefaultDataPath()

  console.log('[camstack] Running setup...')
  console.log(`[camstack] Data directory: ${dataPath}`)

  fs.mkdirSync(dataPath, { recursive: true })
  console.log('[camstack] Data directory: OK')

  console.log(`[camstack] ${describeFfmpegProvisioning(process.env)}`)

  let pythonFound = false
  for (const bin of ['python3', 'python']) {
    try {
      const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
      console.log(`[camstack] Python: ${version} (${bin})`)
      pythonFound = true
      break
    } catch {
      /* not found */
    }
  }
  if (!pythonFound) {
    console.log('[camstack] Python: not found (optional — needed for ML detection addons)')
  }

  console.log('[camstack] Setup complete.')
}
