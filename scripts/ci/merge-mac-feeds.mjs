#!/usr/bin/env node
/**
 * merge-mac-feeds — one electron-updater feed per product, whatever the
 * number of mac legs. Plain node, zero deps (the release job does not `npm ci`).
 *
 * Each mac leg of `release.yml` builds ONE arch, so electron-builder writes a
 * `latest-mac.yml` listing only that arch, and the last upload won: v0.1.1
 * published an x64-only feed and Apple Silicon Macs updated to the Intel build.
 * The legs now upload `<feed>.<arch>.feedpart`; this script merges the parts
 * into `<feed>` — the union of `files` (deduplicated by url), with `version`,
 * `path`, `sha512`, `releaseDate` and every other key from the FIRST part.
 * Parts are ordered x64 before arm64 so the legacy top-level `path` stays the
 * Intel zip, as in the hand-repaired v0.1.1 feed.
 *
 * Usage:
 *   merge-mac-feeds.mjs merge <dir>              <dir>/*.feedpart -> <dir>/<feed>
 *   merge-mac-feeds.mjs check <feed.yml> <arch>… fail if an arch has no entry
 *
 * ADR: docs/architecture/update-and-release.md, "One mac feed per product".
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ARCH_ORDER = ['x64', 'arm64']
const ARCH_IN_URL = /[-_.](arm64|x64)(?=[-_.])/

/**
 * @param {string} text
 * @returns {{ lines: string[], filesStart: number, filesEnd: number, items: { url: string, text: string[] }[] }}
 */
function parseFeed(text) {
  const lines = text.split('\n')
  const filesStart = lines.findIndex((l) => /^files:\s*$/.test(l))
  if (filesStart < 0) throw new Error('feed has no top-level `files:` list')
  let filesEnd = filesStart + 1
  while (filesEnd < lines.length && (lines[filesEnd] === '' ? false : /^\s/.test(lines[filesEnd]))) filesEnd++
  /** @type {{ url: string, text: string[] }[]} */
  const items = []
  for (const line of lines.slice(filesStart + 1, filesEnd)) {
    if (/^\s*-\s/.test(line)) items.push({ url: '', text: [line] })
    else items[items.length - 1]?.text.push(line)
  }
  for (const item of items) {
    const m = item.text.join('\n').match(/\burl:\s*['"]?([^\s,}'"]+)/)
    if (!m) throw new Error(`files entry without a url: ${item.text[0]}`)
    item.url = m[1]
  }
  return { lines, filesStart, filesEnd, items }
}

/**
 * @param {string} text
 * @returns {string}
 */
function versionOf(text) {
  const m = text.match(/^version:\s*['"]?([^\s'"]+)/m)
  if (!m) throw new Error('feed has no `version:`')
  return m[1]
}

/**
 * @param {string[]} feeds feed texts, first one wins the header
 * @returns {string}
 */
export function mergeFeeds(feeds) {
  if (feeds.length === 0) throw new Error('no feed to merge')
  const version = versionOf(feeds[0])
  for (const f of feeds) {
    if (versionOf(f) !== version) throw new Error(`version mismatch: ${version} vs ${versionOf(f)}`)
  }
  if (feeds.length === 1) return feeds[0]
  const first = parseFeed(feeds[0])
  const seen = new Set()
  /** @type {string[]} */
  const merged = []
  for (const f of feeds) {
    for (const item of parseFeed(f).items) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      merged.push(...item.text)
    }
  }
  return [...first.lines.slice(0, first.filesStart + 1), ...merged, ...first.lines.slice(first.filesEnd)].join('\n')
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function feedArches(text) {
  const out = new Set()
  for (const item of parseFeed(text).items) {
    const m = item.url.match(ARCH_IN_URL)
    if (m) out.add(m[1])
  }
  return out
}

/**
 * @param {string} text
 * @param {string[]} expected
 * @returns {string[]}
 */
export function missingArches(text, expected) {
  const have = feedArches(text)
  return expected.filter((a) => !have.has(a))
}

/** @param {string} dir */
function mergeDir(dir) {
  /** @type {Map<string, { arch: string, text: string }[]>} */
  const groups = new Map()
  for (const name of readdirSync(dir).sort()) {
    const m = name.match(/^(.+)\.(arm64|x64)\.feedpart$/)
    if (!m) continue
    const list = groups.get(m[1]) ?? []
    list.push({ arch: m[2], text: readFileSync(join(dir, name), 'utf8') })
    groups.set(m[1], list)
  }
  if (groups.size === 0) throw new Error(`no *.feedpart in ${dir}`)
  for (const [feed, parts] of groups) {
    parts.sort((a, b) => ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch))
    const merged = mergeFeeds(parts.map((p) => p.text))
    const missing = missingArches(
      merged,
      parts.map((p) => p.arch),
    )
    if (missing.length > 0) throw new Error(`${feed}: merged feed lacks ${missing.join(', ')}`)
    writeFileSync(join(dir, feed), merged)
    console.log(`${feed}: merged ${parts.map((p) => p.arch).join(' + ')}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, target, ...rest] = process.argv.slice(2)
  try {
    if (cmd === 'merge' && target) mergeDir(target)
    else if (cmd === 'check' && target && rest.length > 0) {
      const missing = missingArches(readFileSync(target, 'utf8'), rest)
      if (missing.length > 0) throw new Error(`${target}: no entry for ${missing.join(', ')}`)
      console.log(`${target}: has ${rest.join(' + ')}`)
    } else throw new Error('usage: merge <dir> | check <feed.yml> <arch>…')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
