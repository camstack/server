// Node-only utilities — kept off the root `@camstack/types` entry so
// browser bundlers (e.g. Vite widget builds) never traverse `node:fs`,
// `node:path`, etc. Consumers that run on Node (`@camstack/system`,
// `@camstack/system`) import from `@camstack/types/node`.

export type { PlatformInfo } from './deps/binary-downloader.js'
export {
  buildBinaryPath,
  downloadBinary,
  ensureBinary,
  findInPath,
  getPlatformInfo,
} from './deps/binary-downloader.js'
export { ensureFfmpeg } from './deps/ffmpeg-downloader.js'
// The one place a secret-bearing file is restricted to its owner on every OS:
// chmod 0600 on POSIX, an owner+SYSTEM icacls ACL on Windows.
export type { OwnerOnlyDeps } from './util/owner-only-file.js'
export {
  icaclsArgs,
  mkdirOwnerOnlySync,
  OwnerOnlyError,
  restrictDirToOwnerSync,
  restrictFileToOwnerSync,
  writeOwnerOnlyFileSync,
} from './util/owner-only-file.js'
export {
  FFMPEG_RELEASE,
  getFfmpegArtifact,
  getFfmpegDownloadUrl,
} from './deps/ffmpeg-artifacts.js'
// Node-only by nature: it SPAWNS the binary to ask what it can do. Exported
// here rather than from the browser-facing barrel, where it would drag
// `node:child_process` into every bundle that imports a type.
export {
  probeFfmpegBinary,
  parseFfmpegCapabilities,
  type FfmpegBinaryCapabilities,
} from './ffmpeg/binary-capabilities.js'
export {
  ensurePython,
  getPythonDownloadUrl,
  installPythonPackages,
  installPythonRequirements,
  PYTHON_VERSION,
} from './deps/python-downloader.js'
// The Coral delegate (libedgetpu): which file a node loads, and the pinned
// per-OS set the deps downloader stages (zstd .deb payloads read in-process).
export {
  chooseEdgetpuDelegate,
  declaresEdgetpuDelegate,
  EDGETPU_DELEGATE_DIRECTIVE,
  EDGETPU_DELEGATE_RELEASE,
  EDGETPU_LIB_ENV,
  edgetpuDelegateFileName,
  edgetpuLibDir,
  ensureEdgetpuDelegate,
  getEdgetpuDelegateArtifact,
  LEGACY_EDGETPU_LIB,
  nodeDataRootFromEnv,
  type EdgetpuDelegateArtifact,
  type EdgetpuDelegateChoice,
  type EdgetpuDelegateLookup,
  type EdgetpuDelegateOrigin,
  type EdgetpuDelegateResult,
  type EdgetpuStagedFile,
  type EnsureEdgetpuDelegateOptions,
} from './deps/edgetpu-delegate.js'
export {
  debDataMember,
  extractDebPayload,
  installLibraryFromDeb,
  readArMembers,
} from './deps/deb-extract.js'
export type {
  Fmp4FragmentChildArgs,
  Fmp4FragmentChildDeps,
} from './ffmpeg/fmp4-fragment-child.js'
export { Fmp4FragmentChild } from './ffmpeg/fmp4-fragment-child.js'
export type {
  Fmp4CloseReason,
  Fmp4Packet,
  Fmp4PrebufferOptions,
  Fmp4PrebufferStats,
  Fmp4SubscribeInput,
  Fmp4SubscriberInfo,
  Fmp4Subscription,
} from './ffmpeg/fmp4-fragment-plane.js'
// The live fMP4 fragment transport. Off the root entry for the same reason:
// the child spawns, and the plane reaches for `node:crypto`. Two consumers in
// two different runners — the broker's `acquireFragments` and the HKSV
// recording delegate in `addon-export-hap` (D84).
export { Fmp4FragmentPlane } from './ffmpeg/fmp4-fragment-plane.js'
export type {
  FfmpegExit,
  FfmpegExitClass,
  FfmpegProcessOptions,
  FfmpegSpawnFn,
  SpawnedFfmpegProcess,
} from './ffmpeg/process.js'
// The ONE ffmpeg spawn/lifecycle wrapper. Node-only (`node:child_process`), so
// it stays off the root entry alongside the filesystem storage provider (D15).
export { defaultFfmpegSpawn, FfmpegProcess } from './ffmpeg/process.js'
// A one-shot site's spawn: the spec seam, else the node's PINNED binary, else
// null and the site refuses by name — never a PATH `ffmpeg` (D540).
export type {
  FfmpegArgvSpawn,
  PinnedFfmpegSpawnAnswer,
} from './ffmpeg/pinned-spawn.js'
export {
  NO_PINNED_FFMPEG_DETAIL,
  pinnedFfmpegSpawner,
  resolvePinnedFfmpegSpawner,
} from './ffmpeg/pinned-spawn.js'
export type {
  ChildCostClaimHandle,
  ChildCostClaimInput,
  ProcStatReader,
} from './process/child-cost-registry.js'
// The spawn-site half of `load-contribution`: an addon claims the children it
// started and reports their cost itself. Node-only (`node:fs` — it reads
// `/proc/<pid>` on demand), so it stays off the root entry.
export {
  ChildCostRegistry,
  NO_COST_CLAIM,
  nodeProcStatReader,
  parseProcCpuSeconds,
  parseProcRssBytes,
  readProcessCost,
} from './process/child-cost-registry.js'
export { FilesystemStorageProvider } from './storage/filesystem-storage-provider.js'
// Temp-then-rename file replacement (D654) — a reader never sees a torn file.
export { writeFileAtomic } from './storage/atomic-write.js'
// The ONE physical-root derivation (D389): `realpath` plus the containment
// test, shared by the recorder's eviction domain and the orchestrator's
// same-root refusal so the two can never disagree about what "the same disk"
// means.
export type { PhysicalRoot, RealpathSync } from './storage/physical-root.js'
export { containsOrEquals, physicalRootOf } from './storage/physical-root.js'
export { canonicalHash } from './utils/canonical-hash.js'
// The stored name of a device-customization block (D663). Node-only
// (`node:crypto` hashes a ref too long for the name), so off the root entry.
export { customizationBlockName } from './composition/customization-name.js'
export type { VerifyExpiringUrlInput } from './utils/expiring-url-signature.js'
// The ONE signed-expiring-URL derivation. Node-only (`node:crypto`), and here
// rather than in an addon because three planes mint these links and addons never
// import each other — see the module docblock.
export {
  signExpiringUrl,
  verifyExpiringUrl,
} from './utils/expiring-url-signature.js'
export type {
  DeviceExportShape,
  ExportDelta,
  ExportTargetEntry,
} from './utils/export-reconciler.js'
export {
  canonicalDeviceFingerprint,
  diffExportTargets,
  resolveExportFingerprint,
} from './utils/export-reconciler.js'
