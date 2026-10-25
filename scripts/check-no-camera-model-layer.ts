#!/usr/bin/env tsx
/**
 * A model is chosen by the accelerator that runs it; a camera only turns steps
 * on or off (D927).
 *
 * ## The failure this catches
 *
 * A camera used to carry FOUR model layers besides the accelerator's own pin:
 * a per-(camera, node, device) override, a wholesale per-node pipeline copy, a
 * per-camera detector store in the executor, and confidence floors in its
 * camera-wide settings. A camera does not know which accelerator — or which
 * model — the balancer lands it on, so each layer was a way for a stale model
 * or a floor tuned for another model to run unseen. Production had 0 rows of
 * the first two; the surface was pure liability.
 *
 * ## What it checks
 *
 *   1. No method of the `pipeline-orchestrator` cap whose input names a camera
 *      (`deviceId`) carries a `modelId`, a `<key>ModelId` binding or a
 *      `minConfidence*` floor anywhere in its input.
 *   2. A camera's stored pipeline settings (`getCameraSettings`) hold only
 *      `stepToggles` and `stepSettings`.
 *   3. No production source (specs excluded — they keep legacy fixtures to
 *      prove an old row is ignored) names a retired identifier.
 *   4. No UI file that renders ONE camera (the device page) names a
 *      model-picking component. The camera shows each accelerator's model
 *      read-only and links to where it is set; the operator once still saw a
 *      model choice on a camera after the store had stopped reading one. (The
 *      camera settings form itself drops every model-scoped field —
 *      `withoutModelScopedFields`, pinned by its spec.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { pipelineOrchestratorCapability } from '../packages/types/src/capabilities/pipeline-orchestrator.cap.js'
import {
  CAMERA_SCOPED_UI_DIRS,
  cameraScopedModelKeys,
  foreignCameraSettingsKeys,
  modelPickersNamedIn,
  RETIRED_CAMERA_MODEL_IDENTIFIERS,
} from './lib/camera-model-layer.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
// Files that name a retired key BY DESIGN: the list itself and the store
// schema's note on why an old blob loses those keys.
const MAY_NAME_RETIRED = [
  /scripts\/lib\/camera-model-layer\.ts$/,
  /scripts\/check-no-camera-model-layer\.ts$/,
  /addon-pipeline-orchestrator\/src\/orchestrator-store-schemas\.ts$/,
]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === 'generated')
      return []
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name) ? [full] : []
  })
}

function roots(): string[] {
  return ['packages', 'server'].flatMap((top) =>
    readdirSync(path.join(ROOT, top))
      .map((pkg) => path.join(ROOT, top, pkg, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      }),
  )
}

const offenders: string[] = []

for (const [name, method] of Object.entries(pipelineOrchestratorCapability.methods)) {
  const input: unknown = method.input
  if (!(input instanceof z.ZodType)) continue
  for (const key of cameraScopedModelKeys(input)) {
    offenders.push(`pipelineOrchestrator.${name}: a camera-scoped input carries ${key}`)
  }
}

const cameraSettings: unknown = pipelineOrchestratorCapability.methods.getCameraSettings.output
if (cameraSettings instanceof z.ZodType) {
  for (const key of foreignCameraSettingsKeys(cameraSettings)) {
    offenders.push(`pipelineOrchestrator.getCameraSettings: a camera stores ${key}`)
  }
}

const identRe = new RegExp(`\\b(${RETIRED_CAMERA_MODEL_IDENTIFIERS.join('|')})\\b`)
for (const dir of roots()) {
  for (const file of sources(dir)) {
    const rel = path.relative(ROOT, file)
    if (MAY_NAME_RETIRED.some((re) => re.test(rel))) continue
    const hit = identRe.exec(readFileSync(file, 'utf8'))
    if (hit !== null) offenders.push(`${rel}: names the retired per-camera model layer ${hit[1]}`)
  }
}

for (const dir of CAMERA_SCOPED_UI_DIRS) {
  for (const file of sources(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file)
    for (const name of modelPickersNamedIn(readFileSync(file, 'utf8'))) {
      offenders.push(`${rel}: a camera page renders the model picker ${name}`)
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    `check-no-camera-model-layer: a camera carries a model again (D927):\n${offenders.map((o) => `  ${o}`).join('\n')}\n`,
  )
  process.exit(1)
}
process.stdout.write('check-no-camera-model-layer: ok\n')
