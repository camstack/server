/**
 * Hugging Face model references — parse, then resolve against the HF API.
 *
 * The operator types ONE string and gets a fully-pinned download plan. That is
 * the whole surface: this is not an HF browser, and it deliberately cannot
 * discover a model for you — it can only turn a reference you already have
 * into something the node can fetch and verify.
 *
 * ## Why resolution can REFUSE
 *
 * A GGUF repo is not one model. `unsloth/Qwen3.6-35B-A3B-GGUF` ships 25
 * quantizations between 10 GB and 50 GB, and none of them is named `Q4_K_M`
 * (they are `UD-Q4_K_M`, Unsloth's dynamic quant). Any code that "defaults to
 * Q4_K_M" would either fail or, worse, pick a neighbouring file and hand the
 * operator a model they did not ask for after a 20 GB download. So: a repo
 * with more than one candidate is an ERROR that NAMES the candidates, never a
 * guess. The only silent pick is the mmproj precision (F16 over F32) — that
 * choice costs a few hundred MB of projector, not a different model, and the
 * file it picked is reported back.
 *
 * ## The error taxonomy is read from headers, not from the status
 *
 * Probed live on 2026-08-15: huggingface.co answers **401** both for a gated
 * repo and for a repo that does not exist (it refuses to leak whether a
 * private repo is there). The two are distinguishable only by
 * `x-error-code: GatedRepo`. Reading the status alone would tell a
 * typo'd repo name that it is gated, which is the wrong instruction.
 *
 * CamStack never authenticates to Hugging Face: no token is read from the
 * environment or sent. A gated repo is therefore reported as such and cannot
 * be installed — the operator picks an ungated repo or mirror.
 *
 * ## What is verified before a byte is downloaded
 *
 * host is huggingface.co · extension is `.gguf` · every file exists in the
 * tree · the split-GGUF shard set is COMPLETE · the total (main + shards +
 * mmproj) is under the ceiling · a HEAD confirms the file is reachable
 * anonymously and that its size agrees with the tree. The sha256
 * comes free: HF's LFS `oid` IS the sha256 of the file, and `x-linked-etag`
 * repeats it on the HEAD.
 */

import { isMmprojFile } from './mmproj.js'

/** The only hosts a reference may point at. */
const HF_HOSTS: readonly string[] = ['huggingface.co', 'www.huggingface.co']
const HF_API = 'https://huggingface.co/api/models'
const HF_RESOLVE = 'https://huggingface.co'

/**
 * Ceiling on a single install (main + shards + mmproj), overridable per call.
 * 20 GiB admits every sane single-node quantization and stops a mistyped
 * reference from filling a node's disk with a 50 GB BF16 split.
 */
export const DEFAULT_MAX_MODEL_BYTES = 20 * 1024 * 1024 * 1024

export type HfRefErrorCode =
  | 'malformed'
  | 'not-huggingface'
  | 'not-gguf'
  | 'repo-not-found'
  | 'file-not-found'
  | 'gated'
  | 'ambiguous'
  | 'too-large'
  | 'incomplete-shards'
  | 'size-mismatch'
  | 'network'

export interface HfRefError {
  readonly code: HfRefErrorCode
  readonly message: string
  /** Quantization tags (or filenames) the operator can choose between. */
  readonly candidates?: readonly string[]
  /**
   * `too-large` only: what the ceiling would have to be. Carried as a NUMBER
   * because the caller offering "install anyway" needs the value, and digging
   * it back out of the message text would be a parser over prose.
   */
  readonly requiredBytes?: number
}

export interface HfFileRef {
  readonly kind: 'file'
  readonly repo: string
  readonly revision: string
  readonly filePath: string
}

export interface HfRepoRef {
  readonly kind: 'repo'
  readonly repo: string
  readonly revision: string
  readonly quant?: string
}

export type HfRef = HfFileRef | HfRepoRef

export type HfParseOutcome = { ok: true; ref: HfRef } | { ok: false; error: HfRefError }

export interface HfResolvedFile {
  readonly url: string
  readonly filename: string
  readonly sizeBytes: number
  readonly sha256?: string
}

export interface HfResolution {
  readonly repo: string
  readonly revision: string
  /** Picker label, e.g. `Qwen3.6-35B-A3B-GGUF · UD-Q4_K_M`. */
  readonly label: string
  readonly quantization: string
  readonly purpose: 'text' | 'vision'
  readonly main: HfResolvedFile
  /** Shards 2..N and the mmproj — everything that must land beside `main`. */
  readonly extras: readonly HfResolvedFile[]
  readonly totalBytes: number
}

export type HfResolveOutcome =
  | { ok: true; resolution: HfResolution }
  | { ok: false; error: HfRefError }

export interface HfResolveDeps {
  readonly fetchFn?: typeof fetch
  readonly maxBytes?: number
}

// ── parsing ──────────────────────────────────────────────────────────────

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function fail(code: HfRefErrorCode, message: string, candidates?: readonly string[]): HfRefError {
  return { code, message, ...(candidates !== undefined ? { candidates } : {}) }
}

function badParse(
  code: HfRefErrorCode,
  message: string,
  candidates?: readonly string[],
): HfParseOutcome {
  return { ok: false, error: fail(code, message, candidates) }
}

const EXPECTED =
  'expected https://huggingface.co/<org>/<repo>/resolve/main/<file>.gguf, or <org>/<repo>/<file>.gguf, or <org>/<repo>[:<QUANT>]'

/**
 * Reference string → a repo/file reference. Pure: no network, no environment.
 * Every rejection names the form that WAS expected, because the operator is
 * pasting from a browser and a bare "invalid" tells them nothing.
 */
export function parseHfRef(input: string): HfParseOutcome {
  const raw = input.trim()
  if (raw === '') return badParse('malformed', `empty model reference — ${EXPECTED}`)

  return raw.includes('://') ? parseUrlForm(raw) : parseBareForm(raw)
}

function parseUrlForm(raw: string): HfParseOutcome {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return badParse('malformed', `not a URL: ${raw} — ${EXPECTED}`)
  }
  if (!HF_HOSTS.includes(url.hostname)) {
    return badParse(
      'not-huggingface',
      `only huggingface.co models can be installed this way; got host "${url.hostname}"`,
    )
  }
  // /<org>/<repo>/(resolve|blob)/<rev>/<path…>
  const parts = url.pathname.split('/').filter((p) => p !== '')
  const marker = parts.findIndex((p) => p === 'resolve' || p === 'blob')
  if (marker !== 2 || parts.length < marker + 3) {
    return badParse('malformed', `unrecognised Hugging Face URL: ${raw} — ${EXPECTED}`)
  }
  const repo = `${String(parts[0])}/${String(parts[1])}`
  const revision = String(parts[marker + 1])
  const filePath = parts.slice(marker + 2).join('/')
  return finishParse(repo, revision, filePath, raw)
}

function parseBareForm(raw: string): HfParseOutcome {
  const [beforeTag, ...tagRest] = raw.split(':')
  const body = String(beforeTag)
  if (tagRest.length > 1) return badParse('malformed', `too many ":" in ${raw} — ${EXPECTED}`)
  const quant = tagRest[0]?.trim()

  const parts = body.split('/')
  if (parts.length < 2)
    return badParse('malformed', `not an <org>/<repo> reference: ${raw} — ${EXPECTED}`)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return badParse('malformed', `illegal path segment in ${raw} — ${EXPECTED}`)
  }
  const org = String(parts[0])
  const name = String(parts[1])
  if (!SEGMENT_RE.test(org) || !SEGMENT_RE.test(name)) {
    return badParse('malformed', `illegal repo name in ${raw} — ${EXPECTED}`)
  }
  const repo = `${org}/${name}`

  if (parts.length === 2) {
    if (quant !== undefined && quant === '') {
      return badParse('malformed', `empty quantization tag in ${raw} — ${EXPECTED}`)
    }
    return {
      ok: true,
      ref: { kind: 'repo', repo, revision: 'main', ...(quant !== undefined ? { quant } : {}) },
    }
  }
  if (quant !== undefined) {
    return badParse('malformed', `a quantization tag cannot follow an explicit file: ${raw}`)
  }
  return finishParse(repo, 'main', parts.slice(2).join('/'), raw)
}

function finishParse(
  repo: string,
  revision: string,
  filePath: string,
  raw: string,
): HfParseOutcome {
  if (filePath.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    return badParse('malformed', `illegal path segment in ${raw} — ${EXPECTED}`)
  }
  if (!filePath.toLowerCase().endsWith('.gguf')) {
    return badParse(
      'not-gguf',
      `the managed local runtime loads GGUF only; "${filePath}" is not a .gguf file`,
    )
  }
  return { ok: true, ref: { kind: 'file', repo, revision, filePath } }
}

// ── filename shapes ──────────────────────────────────────────────────────

/** `-00001-of-00002` — llama.cpp's split-GGUF naming. */
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})$/
/**
 * One `-`-delimited segment that is a quantization, e.g. `Q4_K_M`, `IQ2_XXS`,
 * `BF16`, `fp16`. The `FP` spellings are not cosmetic: `Qwen/*-GGUF` names its
 * unquantized file `…-fp16.gguf`, and a tag list that cannot name it offers
 * the operator a suggestion that does not parse.
 */
const QUANT_RE = /^(?:I?Q\d[A-Z0-9_]*|TQ\d_\d|BF16|FP?16|FP?32|FP8|MXFP4(?:_MOE)?)$/i

export interface ShardInfo {
  readonly stem: string
  readonly index: number
  readonly total: number
}

/** Shard coordinates of a split GGUF filename, or `null` when unsharded. */
export function shardInfoOf(filename: string): ShardInfo | null {
  const m = SHARD_RE.exec(stripGguf(filename))
  if (m === null) return null
  return { stem: String(m[1]), index: Number(m[2]), total: Number(m[3]) }
}

function stripGguf(filename: string): string {
  return filename.replace(/\.gguf$/i, '')
}

/**
 * The quantization tag of a GGUF filename, uppercased, `UD-` prefix kept —
 * `''` when the name carries no recognisable tag. Shard coordinates are
 * stripped first so `X-BF16-00001-of-00002.gguf` reads as `BF16`.
 */
export function quantizationOf(filename: string): string {
  const stem = shardInfoOf(filename)?.stem ?? stripGguf(filename)
  const segments = stem.split('-')
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = String(segments[i])
    if (!QUANT_RE.test(seg)) continue
    const prev = i > 0 ? String(segments[i - 1]) : ''
    return prev.toUpperCase() === 'UD' ? `UD-${seg.toUpperCase()}` : seg.toUpperCase()
  }
  return ''
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

function dirname(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i < 0 ? '' : filePath.slice(0, i)
}

// ── the HF tree ──────────────────────────────────────────────────────────

interface TreeEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly sha256?: string
}

/** Anonymous requests only — CamStack sends no Hugging Face credential. */
const HF_HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'CamStack/1.0' }

/** HF's 401-for-everything is only decodable through `x-error-code`. */
function authError(response: Response, repo: string): HfRefError {
  const code = response.headers.get('x-error-code') ?? ''
  if (code === 'GatedRepo' || code === 'GatedRepoAccessDenied') {
    return fail(
      'gated',
      `${repo} is a gated Hugging Face repo. CamStack downloads anonymously and cannot install a gated repo — pick an ungated repo or mirror of the same model.`,
    )
  }
  return fail(
    'repo-not-found',
    `${repo} does not exist on huggingface.co, or is private (Hugging Face answers 401 for both). Check the org/repo spelling.`,
  )
}

async function readTree(
  ref: HfRef,
  fetchFn: typeof fetch,
): Promise<{ ok: true; files: readonly TreeEntry[] } | { ok: false; error: HfRefError }> {
  const url = `${HF_API}/${ref.repo}/tree/${ref.revision}?recursive=1`
  let response: Response
  try {
    response = await fetchFn(url, { method: 'GET', headers: { ...HF_HEADERS } })
  } catch (err) {
    return { ok: false, error: fail('network', `could not reach huggingface.co: ${message(err)}`) }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: authError(response, ref.repo) }
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: fail('repo-not-found', `${ref.repo} has no revision "${ref.revision}"`),
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: fail('network', `huggingface.co answered ${String(response.status)} for ${ref.repo}`),
    }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    return { ok: false, error: fail('network', `unreadable tree for ${ref.repo}: ${message(err)}`) }
  }
  if (!Array.isArray(body)) {
    return { ok: false, error: fail('network', `unexpected tree payload for ${ref.repo}`) }
  }
  return { ok: true, files: body.map(toTreeEntry).filter((e): e is TreeEntry => e !== null) }
}

function toTreeEntry(raw: unknown): TreeEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record: Record<string, unknown> = { ...raw }
  if (record['type'] !== 'file') return null
  const filePath = record['path']
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.gguf')) return null
  const lfs =
    typeof record['lfs'] === 'object' && record['lfs'] !== null ? { ...record['lfs'] } : {}
  const lfsSize = (lfs as Record<string, unknown>)['size']
  const oid = (lfs as Record<string, unknown>)['oid']
  const plainSize = record['size']
  const sizeBytes =
    typeof lfsSize === 'number' ? lfsSize : typeof plainSize === 'number' ? plainSize : 0
  return {
    path: filePath,
    sizeBytes,
    ...(typeof oid === 'string' && oid.length === 64 ? { sha256: oid } : {}),
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── selection ────────────────────────────────────────────────────────────

/** Files that can be THE model: not a projector, not a follow-on shard. */
function modelCandidates(files: readonly TreeEntry[]): readonly TreeEntry[] {
  return files.filter((f) => {
    if (isMmprojFile(f.path)) return false
    const shard = shardInfoOf(basename(f.path))
    return shard === null || shard.index === 1
  })
}

function labelFor(file: TreeEntry): string {
  const quant = quantizationOf(basename(file.path))
  return quant === '' ? basename(file.path) : quant
}

function selectMain(
  ref: HfRef,
  files: readonly TreeEntry[],
): { ok: true; file: TreeEntry } | { ok: false; error: HfRefError } {
  const candidates = modelCandidates(files)

  if (ref.kind === 'file') {
    const wanted = ref.filePath.toLowerCase()
    const hit = files.find((f) => f.path.toLowerCase() === wanted)
    if (hit === undefined) {
      return {
        ok: false,
        error: fail(
          'file-not-found',
          `${ref.repo} has no file "${ref.filePath}" at revision ${ref.revision}`,
          candidates.map(labelFor),
        ),
      }
    }
    return { ok: true, file: hit }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: fail(
        'not-gguf',
        `${ref.repo} publishes no GGUF weights (only projectors or no GGUF at all)`,
      ),
    }
  }

  if (ref.quant !== undefined) {
    // A tag matches the quantization OR the filename, because the tag list this
    // module prints on an ambiguous repo contains BOTH forms (a file with no
    // recognisable quant is listed by name) — and every string it prints must
    // be one the operator can paste straight back in.
    const wanted = ref.quant.toUpperCase()
    const wantedFile = stripGguf(ref.quant).toUpperCase()
    const matches = candidates.filter(
      (f) =>
        quantizationOf(basename(f.path)) === wanted ||
        stripGguf(basename(f.path)).toUpperCase() === wantedFile,
    )
    if (matches.length === 0) {
      return {
        ok: false,
        error: fail(
          'file-not-found',
          `${ref.repo} has no "${ref.quant}" quantization. Available: ${candidates.map(labelFor).join(', ')}`,
          dedupe(candidates.map(labelFor)),
        ),
      }
    }
    const only = matches[0]
    if (matches.length > 1 || only === undefined) {
      return {
        ok: false,
        error: fail(
          'ambiguous',
          `"${ref.quant}" matches ${String(matches.length)} files in ${ref.repo}: ${matches.map((f) => basename(f.path)).join(', ')}. Name the file explicitly.`,
          matches.map((f) => basename(f.path)),
        ),
      }
    }
    return { ok: true, file: only }
  }

  const solo = candidates[0]
  if (candidates.length > 1 || solo === undefined) {
    const tags = dedupe(candidates.map(labelFor))
    return {
      ok: false,
      error: fail(
        'ambiguous',
        `${ref.repo} publishes ${String(candidates.length)} quantizations and picking one for you would be a guess. Re-enter it as ${ref.repo}:<TAG>, or paste the full file URL. Available: ${tags.join(', ')}`,
        tags,
      ),
    }
  }
  return { ok: true, file: solo }
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

/** Shards 2..N of `main`, or an error naming the first one that is missing. */
function collectShards(
  main: TreeEntry,
  files: readonly TreeEntry[],
): { ok: true; shards: readonly TreeEntry[] } | { ok: false; error: HfRefError } {
  const shard = shardInfoOf(basename(main.path))
  if (shard === null || shard.total <= 1) return { ok: true, shards: [] }
  const dir = dirname(main.path)
  const out: TreeEntry[] = []
  for (let i = 2; i <= shard.total; i++) {
    const wanted = `${shard.stem}-${String(i).padStart(5, '0')}-of-${String(shard.total).padStart(5, '0')}.gguf`
    const full = dir === '' ? wanted : `${dir}/${wanted}`
    const hit = files.find((f) => f.path === full)
    if (hit === undefined) {
      return {
        ok: false,
        error: fail(
          'incomplete-shards',
          `split GGUF is incomplete: ${wanted} is missing from the repo (llama.cpp needs all ${String(shard.total)} shards)`,
        ),
      }
    }
    out.push(hit)
  }
  return { ok: true, shards: out }
}

/** F16 over BF16 over F32 over whatever came first — reported, never hidden. */
const MMPROJ_PREFERENCE: readonly string[] = ['F16', 'BF16', 'F32']

function selectMmproj(files: readonly TreeEntry[]): TreeEntry | null {
  const projectors = files.filter((f) => isMmprojFile(f.path))
  if (projectors.length === 0) return null
  for (const want of MMPROJ_PREFERENCE) {
    const hit = projectors.find((f) => quantizationOf(basename(f.path)) === want)
    if (hit !== undefined) return hit
  }
  return projectors[0] ?? null
}

// ── HEAD verification ────────────────────────────────────────────────────

function resolveUrl(repo: string, revision: string, filePath: string): string {
  return `${HF_RESOLVE}/${repo}/resolve/${revision}/${filePath}`
}

async function verifyHead(
  url: string,
  repo: string,
  declaredBytes: number,
  fetchFn: typeof fetch,
): Promise<{ ok: true; sha256?: string } | { ok: false; error: HfRefError }> {
  let response: Response
  try {
    // `manual`: the 302 to the CDN is where HF puts `x-linked-size` and
    // `x-linked-etag`. Following it would hand back the CDN's headers instead.
    response = await fetchFn(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { ...HF_HEADERS },
    })
  } catch (err) {
    return { ok: false, error: fail('network', `HEAD ${url} failed: ${message(err)}`) }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: authError(response, repo) }
  }
  if (response.status === 404) {
    return { ok: false, error: fail('file-not-found', `${url} is gone (404)`) }
  }
  if (response.status >= 400) {
    return {
      ok: false,
      error: fail('network', `HEAD ${url} answered ${String(response.status)}`),
    }
  }
  const linked = response.headers.get('x-linked-size') ?? response.headers.get('content-length')
  const headBytes = linked === null ? undefined : Number(linked)
  if (headBytes !== undefined && Number.isFinite(headBytes) && headBytes !== declaredBytes) {
    return {
      ok: false,
      error: fail(
        'size-mismatch',
        `huggingface.co reports ${String(headBytes)} bytes for ${url} but its tree declared ${String(declaredBytes)} — refusing to download a file that changed under the reference`,
      ),
    }
  }
  const etag = response.headers.get('x-linked-etag')?.replace(/"/g, '')
  return { ok: true, ...(etag !== undefined && etag.length === 64 ? { sha256: etag } : {}) }
}

// ── the entry points ─────────────────────────────────────────────────────

function toResolved(repo: string, revision: string, entry: TreeEntry): HfResolvedFile {
  return {
    url: resolveUrl(repo, revision, entry.path),
    filename: basename(entry.path),
    sizeBytes: entry.sizeBytes,
    ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/** Reference → a pinned, size-checked, HEAD-verified download plan. */
export async function resolveHfRef(ref: HfRef, deps: HfResolveDeps): Promise<HfResolveOutcome> {
  const fetchFn = deps.fetchFn ?? fetch
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_MODEL_BYTES

  const tree = await readTree(ref, fetchFn)
  if (!tree.ok) return { ok: false, error: tree.error }

  const picked = selectMain(ref, tree.files)
  if (!picked.ok) return { ok: false, error: picked.error }
  const main = picked.file

  const shards = collectShards(main, tree.files)
  if (!shards.ok) return { ok: false, error: shards.error }

  const projector = isMmprojFile(main.path) ? null : selectMmproj(tree.files)
  const extraEntries = [...shards.shards, ...(projector === null ? [] : [projector])]

  const totalBytes = [main, ...extraEntries].reduce((sum, f) => sum + f.sizeBytes, 0)
  if (totalBytes > maxBytes) {
    return {
      ok: false,
      error: {
        ...fail(
          'too-large',
          `this install is ${String(totalBytes)} bytes (${gb(totalBytes)}), over the ${String(maxBytes)} byte ceiling (${gb(maxBytes)}). Raise the ceiling explicitly if the node really has the disk and RAM for it.`,
        ),
        requiredBytes: totalBytes,
      },
    }
  }

  const head = await verifyHead(
    resolveUrl(ref.repo, ref.revision, main.path),
    ref.repo,
    main.sizeBytes,
    fetchFn,
  )
  if (!head.ok) return { ok: false, error: head.error }

  const mainResolved = toResolved(ref.repo, ref.revision, {
    ...main,
    ...(main.sha256 === undefined && head.sha256 !== undefined ? { sha256: head.sha256 } : {}),
  })
  const quantization = quantizationOf(mainResolved.filename)
  const repoName = ref.repo.slice(ref.repo.indexOf('/') + 1)

  return {
    ok: true,
    resolution: {
      repo: ref.repo,
      revision: ref.revision,
      label: quantization === '' ? repoName : `${repoName} · ${quantization}`,
      quantization,
      purpose: projector === null ? 'text' : 'vision',
      main: mainResolved,
      extras: extraEntries.map((e) => toResolved(ref.repo, ref.revision, e)),
      totalBytes,
    },
  }
}

/** `parseHfRef` then {@link resolveHfRef} — the form the cap method calls. */
export async function resolveHfReference(
  input: string,
  deps: HfResolveDeps,
): Promise<HfResolveOutcome> {
  const parsed = parseHfRef(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return resolveHfRef(parsed.ref, deps)
}
