/**
 * The Coral Edge TPU delegate (libedgetpu) this node loads, and how the deps
 * downloader stages it.
 *
 * The delegate is a native shared library, not a pip package, and its TF
 * version MUST match the interpreter: ai-edge-litert 2.1.6 pairs with
 * feranick's libedgetpu rebuilt against TF 2.17.1 (release
 * `16.0TF2.17.1-1`); Google's stock 16.0 "grouper" build fails at invoke.
 * Every artifact below was fetched and hashed on 2026-10-22 and inspected:
 *
 * - linux x64 / arm64 — the `libedgetpu1-std` deb for Ubuntu 24.04 (the same
 *   build `edgetpu-install.sh` installs on the hub image; it needs glibc
 *   2.38), payload `data.tar.xz`. The std delegate links libusb even for a
 *   PCIe Coral, so Ubuntu 24.04's `libusb-1.0-0` deb is staged beside it —
 *   payload `data.tar.zst`, which is why `deb-extract.ts` reads zstd itself.
 * - darwin arm64 — the `MacOS_Silicon` zip, `throttled/` (the std clock, as on
 *   Linux). `otool -L` shows no libusb: it is linked in, nothing else needed.
 * - darwin x64 — REFUSED: ai-edge-litert 2.1.6 publishes no macOS x86_64
 *   wheel, and the Intel delegate links MacPorts' `/opt/local/lib/libusb`.
 * - win32 — REFUSED: no TF 2.17.1 libedgetpu exists for Windows; Google's old
 *   Windows delegate is built for a TFLite ai-edge-litert 2.1.6 cannot load.
 *
 * Resolution order, mirrored by `edgetpu_device.edgetpu_library_path` in the
 * Python pool: the `CAMSTACK_EDGETPU_LIB` path override → the copy staged
 * under `<CAMSTACK_DATA>/deps/edgetpu/lib/` → the hub's historical
 * `/data/deps/edgetpu/lib/libedgetpu.so.1`. On the hub image
 * `CAMSTACK_DATA=/data`, so the staged path and the historical one are the
 * same file and nothing moves.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IScopedLogger } from '../interfaces/logging.js'
import { extractArchive } from './archive-extract.js'
import { verifySha256 } from './binary-downloader.js'
import { findEntryByName, installLibraryFromDeb } from './deb-extract.js'

/** The path override (a library PATH, never a secret). */
export const EDGETPU_LIB_ENV = 'CAMSTACK_EDGETPU_LIB'

/** The pinned feranick release. Changing it is the delegate version change. */
export const EDGETPU_DELEGATE_RELEASE = '16.0TF2.17.1-1' as const

/** Where the hub image's installer has always put the delegate. */
export const LEGACY_EDGETPU_LIB = '/data/deps/edgetpu/lib/libedgetpu.so.1'

/** One file of the delegate set: where it comes from and the name it is staged as. */
export interface EdgetpuStagedFile {
  readonly url: string
  /** SHA-256 of the downloaded container, verified before a byte is extracted. */
  readonly sha256: string
  readonly sizeBytes: number
  readonly container: 'deb' | 'zip'
  /** deb: the library's file name inside the payload; zip: its path inside the archive. */
  readonly member: string
  /** The name it is staged as in `<deps>/edgetpu/lib/`. */
  readonly installAs: string
}

export type EdgetpuDelegateArtifact =
  | {
      readonly supported: true
      /** The delegate first; libusb (Linux) after it. */
      readonly files: readonly EdgetpuStagedFile[]
    }
  | { readonly supported: false; readonly reason: string }

const FERANICK = `https://github.com/feranick/libedgetpu/releases/download/${EDGETPU_DELEGATE_RELEASE}`

function linuxSet(
  deb: string,
  debSha: string,
  debSize: number,
  libusbUrl: string,
  libusbSha: string,
  libusbSize: number,
): EdgetpuDelegateArtifact {
  return {
    supported: true,
    files: [
      {
        url: `${FERANICK}/${deb}`,
        sha256: debSha,
        sizeBytes: debSize,
        container: 'deb',
        member: 'libedgetpu.so.1',
        installAs: 'libedgetpu.so.1',
      },
      {
        url: libusbUrl,
        sha256: libusbSha,
        sizeBytes: libusbSize,
        container: 'deb',
        member: 'libusb-1.0.so.0',
        installAs: 'libusb-1.0.so.0',
      },
    ],
  }
}

/** The pinned delegate set for a platform and arch, or why there is none. */
export function getEdgetpuDelegateArtifact(
  platform: NodeJS.Platform,
  arch: string,
): EdgetpuDelegateArtifact {
  if (platform === 'linux' && arch === 'x64') {
    return linuxSet(
      'libedgetpu1-std_16.0tf2.17.1-1.ubuntu24.04_amd64.deb',
      '3cd98ae42d26a0ab601673d2162eb968921f751d3879ef960687637cad1cba96',
      389_600,
      'http://archive.ubuntu.com/ubuntu/pool/main/libu/libusb-1.0/libusb-1.0-0_1.0.27-1_amd64.deb',
      'd59e679a82ee2b724c556397e831e879936adbe8a007705872b65a5e1ec887b5',
      54_008,
    )
  }
  if (platform === 'linux' && arch === 'arm64') {
    return linuxSet(
      'libedgetpu1-std_16.0tf2.17.1-1.ubuntu24.04_arm64.deb',
      '6d53b6f6f9a19a6685a488e0c262aed2b11b6ff8c953f10e0aa14a16122f0d37',
      338_416,
      'http://ports.ubuntu.com/ubuntu-ports/pool/main/libu/libusb-1.0/libusb-1.0-0_1.0.27-1_arm64.deb',
      'c8c34ef4385b6be34fe94aabd4de06c7bbd5ae617e80e9306f412f4c979aa5e4',
      54_082,
    )
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      supported: true,
      files: [
        {
          url: `${FERANICK}/libedgetpu-16.0-tf2.17.1-1_MacOS_Silicon.zip`,
          sha256: '5d57b4ff80bfe70d1d9306a3a8a83f52b38e8a151c35aecf68d807744eacf1f4',
          sizeBytes: 760_105,
          container: 'zip',
          member:
            'libedgetpu-16.0-tf2.17.1-1_MacOS_Silicon/throttled/darwin_arm64/libedgetpu.1.0.dylib',
          installAs: 'libedgetpu.1.dylib',
        },
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      supported: false,
      reason:
        'ai-edge-litert 2.1.6 publishes no macOS x86_64 wheel, and the Intel delegate links MacPorts libusb at /opt/local/lib',
    }
  }
  if (platform === 'win32') {
    return {
      supported: false,
      reason:
        'no libedgetpu built against TF 2.17.1 exists for Windows (feranick ships Linux and macOS only)',
    }
  }
  return {
    supported: false,
    reason: `no pinned libedgetpu build for ${platform}-${arch}`,
  }
}

/** The delegate's file name on a platform (what the Python pool loads). */
export function edgetpuDelegateFileName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'libedgetpu.1.dylib' : 'libedgetpu.so.1'
}

/** `<dataDir>/deps/edgetpu/lib` — where the deps downloader stages the set. */
export function edgetpuLibDir(dataDir: string): string {
  return join(dataDir, 'deps', 'edgetpu', 'lib')
}

export type EdgetpuDelegateOrigin = 'override' | 'staged' | 'legacy'

export interface EdgetpuDelegateChoice {
  readonly path: string
  readonly origin: EdgetpuDelegateOrigin
}

export interface EdgetpuDelegateLookup {
  readonly platform: NodeJS.Platform
  /** The node data root (`CAMSTACK_DATA`), or `undefined` when unknown. */
  readonly dataDir: string | undefined
  /** `CAMSTACK_EDGETPU_LIB`, verbatim. */
  readonly override: string | undefined
  readonly exists: (path: string) => boolean
}

/**
 * The delegate this node loads, or `null` when none is present. An override
 * that names a missing file is NOT followed past: the operator said where it
 * is, and a silent fallback would load a different build than they chose.
 */
export function chooseEdgetpuDelegate(lookup: EdgetpuDelegateLookup): EdgetpuDelegateChoice | null {
  const override = lookup.override?.trim()
  if (override !== undefined && override.length > 0) {
    return lookup.exists(override) ? { path: override, origin: 'override' } : null
  }
  if (lookup.dataDir !== undefined && lookup.dataDir.length > 0) {
    const staged = join(edgetpuLibDir(lookup.dataDir), edgetpuDelegateFileName(lookup.platform))
    if (lookup.exists(staged)) return { path: staged, origin: 'staged' }
  }
  if (lookup.exists(LEGACY_EDGETPU_LIB)) {
    return { path: LEGACY_EDGETPU_LIB, origin: 'legacy' }
  }
  return null
}

/** The node data root the way every node process names it. */
export function nodeDataRootFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env['CAMSTACK_DATA'] ?? env['CAMSTACK_DATA_DIR']
}

export type EdgetpuDelegateResult =
  | {
      readonly kind: 'ready'
      readonly path: string
      readonly origin: EdgetpuDelegateOrigin | 'downloaded'
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Under 1 MB each: held whole, written once, hashed from disk before use. */
async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`)
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()))
}

async function stageFile(file: EdgetpuStagedFile, libDir: string, workRoot: string): Promise<void> {
  const target = join(libDir, file.installAs)
  if (existsSync(target)) return
  const work = join(workRoot, file.installAs)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const container = join(work, `download.${file.container}`)
  const partial = `${target}.partial`
  try {
    await download(file.url, container)
    verifySha256(container, file.sha256, file.installAs, file.url)
    if (file.container === 'deb') {
      installLibraryFromDeb(container, file.member, partial, join(work, 'deb'))
    } else {
      const tree = join(work, 'tree')
      mkdirSync(tree, { recursive: true })
      extractArchive(container, 'zip', tree)
      const inner = join(tree, file.member)
      const found = existsSync(inner)
        ? inner
        : findEntryByName(tree, file.member.split('/').pop() ?? file.member)
      if (found === null) throw new Error(`${file.member} not found inside ${file.url}`)
      copyFileSync(found, partial)
    }
    renameSync(partial, target) // a half-written library never sits under its real name
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(partial, { force: true })
  }
}

/**
 * A requirements file names the native library its packages cannot run
 * without on this line; `installPythonRequirements` stages it after pip.
 * (`ai-edge-litert` imports without the delegate and is useless without it.)
 */
export const EDGETPU_DELEGATE_DIRECTIVE = '# camstack-native-dep: edgetpu-delegate'

export function declaresEdgetpuDelegate(requirementsText: string): boolean {
  return requirementsText.split(/\r?\n/).some((line) => line.trim() === EDGETPU_DELEGATE_DIRECTIVE)
}

export interface EnsureEdgetpuDelegateOptions {
  readonly env?: NodeJS.ProcessEnv
  /** The host, for a spec; defaults to this process's. */
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

/**
 * The delegate this node loads, staging the pinned set under
 * `<dataDir>/deps/edgetpu/lib/` when nothing is present yet. Never throws for
 * a platform without a build — it answers `unavailable` with the reason; a
 * download or checksum failure throws, naming the file. The line it logs says
 * which delegate (and from where) the pool will load.
 */
export async function ensureEdgetpuDelegate(
  dataDir: string,
  logger: IScopedLogger,
  opts: EnsureEdgetpuDelegateOptions = {},
): Promise<EdgetpuDelegateResult> {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const override = env[EDGETPU_LIB_ENV]?.trim()
  const present = chooseEdgetpuDelegate({
    platform,
    dataDir,
    override,
    exists: existsSync,
  })
  if (present !== null) {
    logger.info('Coral delegate resolved', {
      meta: { path: present.path, origin: present.origin },
    })
    return { kind: 'ready', path: present.path, origin: present.origin }
  }
  if (override !== undefined && override.length > 0) {
    const reason = `${EDGETPU_LIB_ENV} names a file that does not exist: ${override}`
    logger.error('Coral delegate not staged', { meta: { reason } })
    return { kind: 'unavailable', reason }
  }
  const artifact = getEdgetpuDelegateArtifact(platform, arch)
  if (!artifact.supported) {
    logger.warn('Coral delegate not staged', {
      meta: { reason: artifact.reason },
    })
    return { kind: 'unavailable', reason: artifact.reason }
  }
  const libDir = edgetpuLibDir(dataDir)
  mkdirSync(libDir, { recursive: true })
  logger.info('Coral delegate is not on this node yet — downloading the pinned set', {
    meta: {
      release: EDGETPU_DELEGATE_RELEASE,
      files: artifact.files.map((f) => f.installAs).join(','),
    },
  })
  const workRoot = join(dataDir, 'deps', '.edgetpu-staging')
  try {
    for (const file of artifact.files) {
      await stageFile(file, libDir, workRoot)
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
  const path = join(libDir, edgetpuDelegateFileName(platform))
  logger.info('Coral delegate resolved', {
    meta: { path, origin: 'downloaded' },
  })
  return { kind: 'ready', path, origin: 'downloaded' }
}
