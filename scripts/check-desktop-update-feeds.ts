#!/usr/bin/env tsx
/**
 * Desktop update-feed guard — two products, never one feed file.
 *
 * ── What this prevents ─────────────────────────────────────────────────────
 * The desktop shell builds TWO products from one source tree (D402): the full
 * `CamStack` and the reduced `CamStack Viewer`. Both publish to the SAME GitHub
 * release, and electron-updater's feed is ONE file per channel per platform —
 * `latest-mac.yml`, `latest-linux.yml`, `latest.yml`. With both configs on the
 * default channel the second leg to finish OVERWRITES the first's feed.
 *
 * Measured on release v1.2.338, downloading the live file:
 *
 *     version: 1.2.338
 *     path: CamStackViewer-1.2.338-arm64.dmg
 *
 * — the FULL app's macOS updater, pointed at the reduced product. It failed
 * safe only by accident: `MacUpdater` applies a `.zip` and the viewer shipped
 * only a `.dmg`, so it threw `ERR_UPDATER_ZIP_FILE_NOT_FOUND` rather than
 * installing the wrong product. Which is the second rule below, and the reason
 * the two are ONE guard: adding the missing zip while the channels still
 * collide converts a failure into a real cross-product install. (ADR-0584.)
 *
 * Nothing about any of this is self-enforcing: a channel is one absent key in a
 * JSON file, and its absence means "the shared name".
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 *  1. each product declares an explicit, non-empty `publish[].channel`;
 *  2. the two channels differ, and the feed FILENAMES they produce differ on
 *     every platform and arch — the name is what collides, not the channel;
 *  3. a product with a mac target whose updater is enabled ships `zip`:
 *     Squirrel.Mac cannot apply a `.dmg`;
 *  4. the runtime agrees with the publish side — the constants in
 *     `packages/desktop/src/product/update-channel.ts` (which `initAutoUpdater`
 *     hands to `autoUpdater.channel`) are the channels the configs publish to.
 *     A channel the runtime does not also select is half a fix;
 *  5. every desktop leg in `release.yml` stages its own feed, by a glob that
 *     belongs to its channel. The step used to copy `latest*.yml` for both
 *     legs — which after the split would have shipped no viewer feed at all.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NODE_UPDATE_CHANNEL,
  UPDATE_FEED_PLATFORMS,
  VIEWER_UPDATE_CHANNEL,
  updateFeedFileName,
} from '../packages/desktop/src/product/update-channel.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DESKTOP = path.join(ROOT, 'packages/desktop')
const VIEWER_CONFIG = path.join(DESKTOP, 'electron-builder.viewer.json')
const PACKAGE_JSON = path.join(DESKTOP, 'package.json')
const RELEASE_WORKFLOW = path.join(ROOT, '.github/workflows/release.yml')

/** The architectures either product is built for, on any platform. */
const ARCHES = ['x64', 'arm64'] as const

interface ProductConfig {
  /** How the leg names itself in the release matrix. */
  readonly leg: string
  /** Human name, for the failure text. */
  readonly label: string
  /** The electron-builder configuration object. */
  readonly config: Record<string, unknown>
  /** The channel `src/product/update-channel.ts` hands the runtime. */
  readonly runtimeChannel: string
  /** Does this product's packaged metadata carry electron-updater? */
  readonly updaterEnabled: boolean
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** electron-builder accepts `"zip"` and `{ target: "zip" }` — normalise both. */
function targetNames(platformConfig: unknown): readonly string[] {
  const targets = (platformConfig as { target?: unknown } | undefined)?.target
  if (targets === undefined || targets === null) return []
  const list = Array.isArray(targets) ? targets : [targets]
  return list
    .map((entry) =>
      typeof entry === 'string' ? entry : ((entry as { target?: unknown }).target ?? ''),
    )
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function publishEntries(config: Record<string, unknown>): readonly Record<string, unknown>[] {
  const publish = config['publish']
  if (publish === undefined || publish === null) return []
  const list = Array.isArray(publish) ? publish : [publish]
  return list.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
}

function declaredChannel(config: Record<string, unknown>, violations: string[], label: string) {
  const entries = publishEntries(config)
  if (entries.length === 0) {
    violations.push(`${label}: no \`publish\` block — it cannot declare a channel`)
    return null
  }
  const channels = new Set<string>()
  for (const entry of entries) {
    const channel = entry['channel']
    if (typeof channel !== 'string' || channel.length === 0) {
      violations.push(
        `${label}: a \`publish\` entry has no \`channel\` — an absent channel is the SHARED name (\`latest\`), which is the collision`,
      )
      return null
    }
    channels.add(channel)
  }
  if (channels.size !== 1) {
    violations.push(
      `${label}: its \`publish\` entries declare ${channels.size} different channels (${[...channels].join(', ')}) — the product has one feed`,
    )
    return null
  }
  return [...channels][0] as string
}

function main(): void {
  const violations: string[] = []

  for (const file of [VIEWER_CONFIG, PACKAGE_JSON, RELEASE_WORKFLOW]) {
    if (!fs.existsSync(file)) {
      // eslint-disable-next-line no-console
      console.error(
        `\n\x1b[31m✘ desktop-update-feed guard failed\x1b[0m\n    - ${path.relative(ROOT, file)} is gone\n`,
      )
      process.exit(1)
    }
  }

  const pkg = readJson(PACKAGE_JSON)
  const viewerConfig = readJson(VIEWER_CONFIG)
  const fatConfig = (pkg['build'] ?? {}) as Record<string, unknown>
  const viewerMetadataDeps = (
    viewerConfig['extraMetadata'] as { dependencies?: Record<string, unknown> } | undefined
  )?.dependencies
  const fatDeps = pkg['dependencies'] as Record<string, unknown> | undefined

  const products: readonly ProductConfig[] = [
    {
      leg: 'desktop',
      label: 'packages/desktop/package.json `build`',
      config: fatConfig,
      runtimeChannel: NODE_UPDATE_CHANNEL,
      updaterEnabled: fatDeps !== undefined && 'electron-updater' in fatDeps,
    },
    {
      leg: 'desktop-viewer',
      label: 'packages/desktop/electron-builder.viewer.json',
      config: viewerConfig,
      runtimeChannel: VIEWER_UPDATE_CHANNEL,
      updaterEnabled: viewerMetadataDeps !== undefined && 'electron-updater' in viewerMetadataDeps,
    },
  ]

  // Rules 1 + 4 — an explicit channel, and the runtime selects the same one.
  const channels = new Map<string, string>()
  for (const product of products) {
    const channel = declaredChannel(product.config, violations, product.label)
    if (channel === null) continue
    channels.set(product.leg, channel)
    if (channel !== product.runtimeChannel) {
      violations.push(
        `${product.label}: publishes to \`${channel}\` but src/product/update-channel.ts hands the runtime \`${product.runtimeChannel}\` — the app would ask for a feed nobody writes`,
      )
    }
  }

  // Rule 2 — the FILENAMES, not just the channel strings.
  if (channels.size === products.length) {
    for (const platform of UPDATE_FEED_PLATFORMS) {
      for (const arch of ARCHES) {
        const byFile = new Map<string, string[]>()
        for (const [leg, channel] of channels) {
          const file = updateFeedFileName(channel, platform, arch)
          byFile.set(file, [...(byFile.get(file) ?? []), leg])
        }
        for (const [file, legs] of byFile) {
          if (legs.length > 1) {
            violations.push(
              `on ${platform}/${arch} the products ${legs.join(' and ')} both publish \`${file}\` — one feed cannot answer for two apps; the last leg to finish wins (measured: v1.2.338 latest-mac.yml named CamStackViewer-1.2.338-arm64.dmg)`,
            )
          }
        }
      }
    }
  }

  // Rule 3 — Squirrel.Mac applies a zip, never a dmg.
  for (const product of products) {
    const macTargets = targetNames(product.config['mac'])
    if (macTargets.length === 0) continue
    if (!product.updaterEnabled) continue
    if (!macTargets.includes('zip')) {
      violations.push(
        `${product.label}: mac targets are [${macTargets.join(', ')}] with electron-updater shipped — Squirrel.Mac applies a \`zip\`, so the update downloads and then throws ERR_UPDATER_ZIP_FILE_NOT_FOUND`,
      )
    }
  }

  // Rule 5 — every leg stages ITS feed.
  const workflow = fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
  const legs = workflow.match(/\{target:"desktop[^\n]*?\}/g) ?? []
  if (legs.length === 0) {
    violations.push('release.yml declares no desktop legs — the matrix shape changed')
  }
  const globsByLeg = new Map<string, Set<string>>()
  for (const leg of legs) {
    const target = /target:"([^"]+)"/.exec(leg)?.[1] ?? '?'
    const glob = /feed_glob:"([^"]+)"/.exec(leg)?.[1]
    const channel = channels.get(target)
    if (glob === undefined) {
      violations.push(
        `release.yml leg \`${target}\` declares no \`feed_glob\` — the staging step would copy a hard-coded \`latest*.yml\` and ship the wrong product's feed, or none`,
      )
      continue
    }
    globsByLeg.set(target, (globsByLeg.get(target) ?? new Set()).add(glob))
    if (channel !== undefined && !glob.startsWith(channel)) {
      violations.push(
        `release.yml leg \`${target}\` stages \`${glob}\` but its config publishes channel \`${channel}\` — the feed it writes is never attached to the release`,
      )
    }
  }
  for (const [legA, globsA] of globsByLeg) {
    for (const [legB, globsB] of globsByLeg) {
      if (legA >= legB) continue
      for (const g of globsA) {
        if (globsB.has(g)) {
          violations.push(
            `release.yml legs \`${legA}\` and \`${legB}\` stage the same feed glob \`${g}\` — two products, one file, last upload wins`,
          )
        }
      }
    }
  }
  // A leg's glob is `feed_glob:"latest*.yml"` and that is fine; what is not is
  // a COPY of a literal feed name, which is how one glob served both products.
  for (const line of workflow.split('\n')) {
    if (!/^\s*cp\b/.test(line)) continue
    if (/latest\*?\.yml|viewer\*?\.yml/.test(line)) {
      violations.push(
        `release.yml copies a hard-coded feed name (\`${line.trim()}\`) — use \`matrix.feed_glob\` so each leg stages its own channel`,
      )
    }
  }

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '  \x1b[32m✔\x1b[0m  each desktop product owns its update channel end to end, publishes a distinct feed file per platform, and ships the mac zip its updater needs',
    )
    return
  }

  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ desktop-update-feed guard failed\x1b[0m')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`    - ${v}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
