/**
 * Public surface of the packages-rule options (D931). The frame loop and the
 * specs talk to this module; the pieces stay in their own files.
 */

export {
  PACKAGE_SCENE_DIFF_LOOK_GAP_MS,
  PACKAGE_SCENE_DIFF_SETTLE_MS,
} from './package-scene-diff.js'
export {
  PACKAGE_LLM_CONFIRM_TIMEOUT_MS,
  confirmPackageWithLlm,
  type PackageLlmConfirmOutcome,
  type PackageLlmGenerate,
} from './package-llm-confirm.js'
export {
  stepPackageScene,
  type PackageSceneState,
} from './package-scene-step.js'
export type { PackageZoneLuma } from './package-scene-diff.js'
