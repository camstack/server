/**
 * Serves the bundled test-notification sample media over the addon's own HTTP
 * surface via the `addon-routes` cap. One public GET route per sample:
 *
 *   GET /addon/notifiers/samples/<name>  →  the bundled sample bytes
 *
 * WHY THIS EXISTS
 * ───────────────
 * The test panel used to attach `https://example.com/sample.jpg` — the IANA
 * reserved documentation domain, which serves no media. Every "does my target
 * deliver an image / gif / video" test was therefore broken by construction and
 * had never verified anything. The samples have to live somewhere the addon can
 * actually fetch, on an install with no internet, so they ship with the addon.
 *
 * The bytes are read from `assets/samples/` (not embedded in TS): a 128 KB mp4
 * as a base64 literal would inflate the bundle by ~170 KB of source. Path
 * resolution mirrors `addon-benchmark`'s `resolveFixturesDir` — `import.meta.url`
 * always points at the compiled bundle under `dist/`, so walking up one
 * directory lands on the package root whether the addon runs from source (tsx)
 * or from its built bundle.
 *
 * CONTENT-ENCODING IS OURS, DELIBERATELY
 * ──────────────────────────────────────
 * Same hazard `icon-routes.ts` documents: the hub pipes an addon route's reply
 * through its global `@fastify/compress`, and on the forked-addon UDS route
 * bridge that compressor emits an EMPTY brotli stream for a compressible body
 * over 1 KiB. The compressor skips a response that already declares a
 * non-identity `content-encoding`, so we negotiate and stamp it ourselves.
 *
 * Media types here are all ALREADY compressed (JPEG/GIF/MP4/MP3), so we serve
 * identity bytes and stamp `content-encoding: identity` — re-compressing them
 * wastes CPU for no gain, and the explicit header is what keeps the hub's
 * compressor off a body it would corrupt.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type IAddonHttpRoute } from '@camstack/types'

/** The addon id — also the `/addon/<id>/…` route prefix. Mirrors `NOTIFIERS_ADDON_ID`. */
const NOTIFIERS_ROUTE_ID = 'notifiers'

/** Samples are immutable per addon version. */
const CACHE_CONTROL = 'public, max-age=86400, immutable'

/** One bundled sample: its route name, file and media type. */
interface SampleDefinition {
  /** Route segment AND the `sampleUrlFor` key. */
  readonly name: string
  /** Filename under `assets/samples/`. */
  readonly file: string
  readonly contentType: string
}

/**
 * The bundled set. Keyed by the `AttachmentMediaType` each one exercises, so a
 * caps-driven test panel can ask for "the sample for this media type" without
 * knowing filenames. `icon` deliberately reuses the image sample — an icon slot
 * wants a small raster, and shipping a fifth file to say the same thing is
 * waste.
 */
const SAMPLES: readonly SampleDefinition[] = [
  { name: 'image', file: 'image.jpg', contentType: 'image/jpeg' },
  { name: 'gif', file: 'animation.gif', contentType: 'image/gif' },
  { name: 'video', file: 'clip.mp4', contentType: 'video/mp4' },
  { name: 'audio', file: 'tone.mp3', contentType: 'audio/mpeg' },
  { name: 'icon', file: 'image.jpg', contentType: 'image/jpeg' },
]

const SAMPLE_NAMES: ReadonlySet<string> = new Set(SAMPLES.map((s) => s.name))

/** `true` when a bundled sample exists for `name`. */
export function hasSample(name: string): boolean {
  return SAMPLE_NAMES.has(name)
}

/**
 * The stable per-sample URL, or `undefined` when nothing is bundled for that
 * name. Root-relative so it resolves against whatever origin serves the client;
 * a native client joins it onto its hub base exactly as it does for icons.
 */
export function sampleUrlFor(name: string): string | undefined {
  return hasSample(name) ? `/addon/${NOTIFIERS_ROUTE_ID}/samples/${name}` : undefined
}

/** Resolve the addon's bundled samples directory (see the file header). */
function resolveSamplesDir(): string {
  const here = fileURLToPath(import.meta.url)
  const pkgRoot = path.resolve(path.dirname(here), '..')
  return path.join(pkgRoot, 'assets', 'samples')
}

/** A sample's bytes, read once at module load (they are immutable). */
interface LoadedSample {
  readonly contentType: string
  readonly bytes: Uint8Array
}

/**
 * Read every sample eagerly so a missing asset fails at BOOT with a clear
 * error, rather than on the first operator click with a 500 that reads as a
 * broken notifier.
 */
function loadSamples(): ReadonlyMap<string, LoadedSample> {
  const dir = resolveSamplesDir()
  const out = new Map<string, LoadedSample>()
  for (const sample of SAMPLES) {
    const bytes = readFileSync(path.join(dir, sample.file))
    out.set(sample.name, { contentType: sample.contentType, bytes })
  }
  return out
}

/** One static GET route serving a single bundled sample. */
function sampleRoute(sample: SampleDefinition, loaded: LoadedSample): IAddonHttpRoute {
  return {
    method: 'GET',
    path: `/samples/${sample.name}`,
    access: 'public',
    description: `Bundled ${sample.contentType} test sample for the '${sample.name}' attachment slot.`,
    handler: async (_request, reply) => {
      reply
        .code(200)
        .type(loaded.contentType)
        .header('cache-control', CACHE_CONTROL)
        // Already-compressed media: identity bytes, and the explicit header is
        // what keeps the hub's compressor off a body it would corrupt.
        .header('content-encoding', 'identity')
        .header('content-length', String(loaded.bytes.byteLength))
      reply.send(loaded.bytes)
    },
  }
}

/**
 * The sample routes, for composition into the addon's SINGLE `addon-routes`
 * provider. Deliberately not a provider of its own: a provider owns one route
 * id and matches paths within it, so two providers sharing `notifiers` would
 * collide — the icons and the samples must travel in one route set.
 */
export function sampleRoutes(): readonly IAddonHttpRoute[] {
  const loaded = loadSamples()
  return SAMPLES.map((sample) => {
    const bytes = loaded.get(sample.name)
    if (bytes === undefined) throw new Error(`notifiers: sample '${sample.name}' failed to load`)
    return sampleRoute(sample, bytes)
  })
}
