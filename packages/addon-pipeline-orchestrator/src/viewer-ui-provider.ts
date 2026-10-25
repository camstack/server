/**
 * viewer-ui provider — the pipeline-orchestrator serves the CamStack viewer web
 * SPA (mirrors what the now-removed standalone addon-viewer-ui used to do).
 *
 * Why here: the orchestrator is a hub bootstrap addon (always installed + baked),
 * so folding the viewer serving into it avoids a second addon whose only job was
 * to hold static files. The viewer's Expo web export is COPIED into this addon's
 * `assets/viewer/` locally by the viewer repo's `scripts/copy-dist-to-orchestrator.js`
 * (run from a checkout that HAS the `camstack/` submodule + Expo toolchain — the
 * publish/image CI does not, which is exactly why we copy a pre-built dist rather
 * than build it here). vite emits only into `dist/`, so `assets/viewer` survives
 * the addon build; `assets` is in the package `files`, so it ships on
 * `camstack deploy`. The hub's `main.ts` resolves the `viewer-ui` singleton at
 * boot and mounts the SPA at `/viewer/camstack`.
 *
 * `index.js` runs from `dist/`, so the SPA root is one level up + `assets/viewer`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IViewerUiProvider } from '@camstack/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the staged viewer web SPA (`<addon-root>/assets/viewer`). */
export function resolveViewerDistDir(): string {
  return path.resolve(__dirname, '..', 'assets', 'viewer')
}

/** Version of the staged viewer, written by the copy script; 'unknown' if absent. */
function readViewerVersion(): string {
  try {
    const raw = fs
      .readFileSync(path.join(resolveViewerDistDir(), '.viewer-version'), 'utf-8')
      .trim()
    if (raw) return raw
  } catch {
    // No staged viewer (e.g. a CI-built addon without the local copy) → unknown.
  }
  return 'unknown'
}

/** Build the viewer-ui provider. Serves whatever dist was staged into
 *  `assets/viewer`; when nothing is staged the hub's mount cleanly 404s. */
export function createViewerUiProvider(): IViewerUiProvider {
  return {
    getStaticDir: async () => ({ staticDir: resolveViewerDistDir() }),
    getVersion: async () => ({ version: readViewerVersion() }),
  }
}
