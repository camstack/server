#!/usr/bin/env tsx
/**
 * ffmpeg-primitive guard — refuses a second argv builder, an ffmpeg spawned
 * outside the primitive, and a mutable shared transcode handle.
 *
 * The repo reached a state where the SAME job had two argv builders that
 * disagreed about hardware: the broker's (hwaccel-aware, hardware-encoder
 * picker, `-threads`) served exactly one call site, while the WebRTC/derived
 * one — hand-rolled, no hardware encoder, no `-threads` — served the rest. Both
 * looked correct in isolation. Nothing caught it because nothing was looking.
 *
 * Three rules, all conservative:
 *
 *   Rule 1 — ONE argv builder.
 *     Outside `packages/types/src/ffmpeg/`, no file may export a function whose
 *     name matches `build*(Ffmpeg|Transcode)*Args`. Consumers COMPOSE the
 *     shared builder; they do not grow their own.
 *
 *   Rule 2 — no ffmpeg spawned outside the primitive.
 *     A `spawn(…)` / `execFile(…)` whose first argument mentions ffmpeg is
 *     flagged unless the file is in `SPAWN_ALLOWLIST`. The allowlist is not a
 *     loophole: every entry is a spawn site the primitive deliberately does NOT
 *     own, and the reason is recorded next to it.
 *
 *   Rule 3 — a shared handle is IMMUTABLE.
 *     No capability method may accept a `pipelineKey` together with encode
 *     parameters. A consumer whose requirements change RELEASES and
 *     re-acquires; the refcount does the rest. A mutable shared handle is
 *     exactly what made Alexa's `derived:alexa-<id>` a co-tenant hazard — one
 *     consumer's downgrade dragged every co-tenant to 360p.
 *
 * ## False positives — the argument
 *
 * Rule 2 matches on the literal token `ffmpeg` appearing in the binary
 * expression of a spawn call. A variable-named binary (`spawn(bin, args)`) is
 * NOT matched, so the guard under-reports rather than over-reports: it cannot
 * flag a site that resolves its binary indirectly. That is the deliberate
 * trade. A false POSITIVE would require a non-ffmpeg spawn whose binary
 * expression contains the substring "ffmpeg", which in this repo would itself
 * be worth a look.
 *
 * ## Blind spot — stated plainly
 *
 * The guard is textual. It cannot see:
 *   - a spawn reached through an injected `spawnFn` whose binary comes from
 *     config (`this.deps.ffmpegBinaryPath`) — this is exactly how the primitive
 *     itself spawns, so the rule cannot distinguish "uses the primitive" from
 *     "hand-rolled with an injected spawn" without type information;
 *   - argv assembled inline at a call site rather than in a named function
 *     (Rule 1 keys on the NAME);
 *   - a builder named something else entirely (`makeArgs`, `ffArgs`).
 * Rule 1 is therefore a tripwire for the specific failure that happened, not a
 * proof of uniqueness. The stronger check is the one in
 * `packages/addon-pipeline/src/stream-broker/webrtc/__tests__/build-transcode-args.spec.ts`,
 * which asserts the WebRTC leg's argv is byte-identical to the shared builder's.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** The primitive itself — the one place an argv builder may live. */
const PRIMITIVE_DIR = path.join(ROOT, 'packages/types/src/ffmpeg')

const SCAN_ROOTS = [path.join(ROOT, 'packages'), path.join(ROOT, 'server/backend/src')]

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  'worktrees',
])

/**
 * Spawn sites the primitive deliberately does NOT own. Each is a deliberate
 * boundary, not an exemption of convenience.
 */
const SPAWN_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  // ── DECODE, not egress. These decode to raw frames and own the hwaccel
  // CASCADE (vaapi→qsv→software with GOP replay) that the primitive READS as
  // its authority. Putting them behind the primitive would invert that.
  [
    'packages/addon-pipeline/src/stream-broker/stream-broker/ffmpeg-decoder-session.ts',
    'broker MJPEG decode session — decode to frames, not an encoded egress',
  ],
  // ── PROBES. No media, no lifecycle worth sharing.
  [
    'packages/types/src/deps/binary-downloader.ts',
    'binary presence check before download — the binary is the SUBJECT',
  ],
  // ── SOURCE INGRESS. Reads a camera INTO the broker; the primitive is the
  // egress half. Remux-only (`-c copy`), so there is no encode plan to share.
  [
    'packages/addon-pipeline/src/stream-broker/rtsp/ffmpeg-push-reader.ts',
    'source ingress — `-c copy` remux to MPEG-TS, no encode plan',
  ],
  // ── FILE-ORIENTED, RUN-TO-COMPLETION. Segment mux, export render, still
  // frame, clip, timelapse, snapshot. Different lifecycle (finish vs stay
  // alive), file sinks, and mostly `-c copy` — absorbing them would grow the
  // builder a file-mux dimension for no hardware benefit.
  ['packages/addon-pipeline/src/recorder/addon/segment-writer.ts', 'recorder segment mux'],
  ['packages/addon-pipeline/src/recorder/addon/export-engine.ts', 'export render job'],
  [
    'packages/addon-pipeline/src/recorder/addon/export-shrink-for-read.ts',
    'one-shot re-encode of a FINISHED export file down a CRF ladder so its read fits the delivery bound — file in, file out, run to completion',
  ],
  ['packages/addon-pipeline/src/recorder/addon/footage-render.ts', 'notification clip/GIF render'],
  ['packages/addon-pipeline/src/recorder/still/still-frame-service.ts', 'single-JPEG still grab'],
  ['packages/addon-pipeline/src/stream-broker/recorded/ffmpeg-run-once.ts', 'one fragment convert'],
  [
    'packages/addon-pipeline/src/pipeline-runner/node-bench/bench-frames.ts',
    'node benchmark: one-shot decode of the verified bench clip into RAM at run start — file in, frames out, run to completion; not live media',
  ],
  // ── LOCAL BENCHES. A developer tool run by hand against a recorded clip:
  // outside `src/`, never built, never shipped, never on a node.
  [
    'packages/addon-pipeline/scripts/appearance-cost-bench.ts',
    'D683 appearance-cost bench — decodes a recorded clip to raw RGB on a dev machine; not product code',
  ],
  // ── ONBOARD CLIPS, all three vendors. A clip pass is `-c copy` on the video
  // with at most an AUDIO transcode beside it (the archives are AAC or µ-law
  // and no WebRTC session speaks either), so there is no encode plan and no
  // hwaccel decision for the primitive to own. The file form runs to
  // completion into a scratch file; the stream form is a forward-only fMP4
  // into ONE peer socket whose liveness signal is that socket, not a broker
  // egress the primitive tracks. These entries were MISSING while the five
  // sites existed, so the guard was red at `1104f812` before D617 added the
  // sixth — recorded here rather than silently amnestied.
  [
    'packages/addon-provider-reolink/src/clips/clip-service.ts',
    'clip file/stream mux — `-c copy` video, audio transcode only',
  ],
  [
    'packages/addon-provider-hikvision/src/clips/clip-file.ts',
    'clip file mux — run-to-completion into the scratch',
  ],
  [
    'packages/addon-provider-hikvision/src/clips/clip-still.ts',
    'single-JPEG still cut from a file already fetched',
  ],
  [
    'packages/addon-provider-hikvision/src/clips/clip-stream.ts',
    'forward-only clip fMP4 into one peer socket',
  ],
  [
    'packages/addon-provider-amcrest/src/clips/clip-file.ts',
    'clip file re-index — `-c copy -movflags +faststart`',
  ],
  [
    'packages/addon-provider-amcrest/src/clips/clip-stream.ts',
    'forward-only clip fMP4 from `/cam/playback` into one peer socket',
  ],
  // Added 2026-09-23: the site landed in a71aeade3 without its entry and the
  // static job was red on this guard for every push after it.
  [
    'packages/addon-provider-amcrest/src/clips/clip-still.ts',
    "single-JPEG still cut from the camera's replay at the clip midpoint",
  ],
  [
    'packages/addon-pipeline/src/stream-broker/stream-broker/prebuffer-clip.ts',
    'pre-buffer clip render',
  ],
  [
    'packages/addon-post-analysis/src/notification-center/timelapse/assembler.ts',
    'timelapse assembly',
  ],
  ['packages/system/src/builtins/snapshot/snapshot.addon.ts', 'keyframe snapshot grab'],
  ['packages/system/src/builtins/snapshot/snapshot-resize.ts', 'snapshot resize'],
  ['packages/addon-provider-wyze/src/snapshot-ffmpeg.ts', 'provider snapshot grab'],
  [
    'server/backend/src/core/streaming/stream-probe.service.ts',
    "stream probe — the pinned ffmpeg's `-i` input report, no output",
  ],
  // ── HomeKit. Its ENCODE block MOVED behind the primitive (the argv now comes
  // from `buildFfmpegArgs` via `buildSessionInvocation`); only the SPAWN stays
  // here, and it stays for a reason the wrapper itself states: `FfmpegProcess`
  // decides a child is live from its FIRST STDOUT BYTE, and a HomeKit session
  // has no stdout at all — its outputs are two RTP sockets, and its liveness
  // signal is `videoPacketsForwarded` on the loopback the JS-side SRTP encrypt
  // reads. Its hardware→software retry additionally gates on four more
  // session-scoped conditions (`shouldRetryInSoftware`), including whether the
  // CONTROLLER asked to stop — iOS restarts a session it is not enjoying, and
  // that is indistinguishable from a crash at the exit code. Teaching the
  // wrapper a mode per consumer is the same mistake as one builder per
  // consumer.
  [
    'packages/addon-export-hap/src/mappers/builders/camera-streams.ts',
    'HomeKit SRTP egress spawn — no stdout, liveness is forwarded RTP; argv comes from the shared builder',
  ],
  // ── The primitive's own broker-side host.
  [
    'packages/addon-pipeline/src/stream-broker/stream-broker/transcode-egress.ts',
    'the broker half of the primitive — it IS the spawn site',
  ],
  [
    'packages/addon-pipeline/src/stream-broker/webrtc/session.ts',
    'WebRTC transcode leg — argv comes from the shared builder; MIGRATION PENDING for the lifecycle wrapper',
  ],
]

/**
 * Argv builders that are NOT the transcode builder. Each is a boundary the
 * primitive deliberately does not cross, with the reason recorded.
 */
const BUILDER_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  // HomeKit's entry is GONE, and its absence is the point: `stream-ffmpeg-args.ts`
  // no longer builds an argv at all. `buildSessionInvocation` returns an
  // `FfmpegInvocation` and `buildFfmpegArgs` emits it, so the name no longer
  // matches Rule 1 and no exemption is needed. If a future edit reintroduces a
  // `build…FfmpegArgs` there, the guard fires — which is the outcome the entry
  // used to prevent.
  //
  // DECODE argv (to raw frames), owning the vaapi→qsv→software cascade the
  // primitive READS as its hwaccel authority. Not an egress encode.
  ['packages/addon-pipeline/src/shared/ffmpeg-decode-args.ts', 'shared decode argv'],
  // SOURCE INGRESS — `-c copy` remux into the broker, no encode plan.
  [
    'packages/addon-pipeline/src/stream-broker/rtsp/ffmpeg-source-reader-args.ts',
    'source ingress remux argv',
  ],
  // FILE-ORIENTED run-to-completion jobs — different lifecycle, file sinks.
  ['packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts', 'recorder segment mux argv'],
  [
    'packages/addon-post-analysis/src/notification-center/timelapse/assembler.ts',
    'timelapse assembly argv',
  ],
  // THIN COMPOSERS over the shared builder. These add no arguments of their
  // own — they choose a sink and a plan and delegate. Verified by their specs.
  [
    'packages/addon-pipeline/src/stream-broker/derived/derived-transcode-args.ts',
    'composes the shared builder — chooses the mpegts sink and forceReencode',
  ],
  [
    'packages/addon-pipeline/src/stream-broker/stream-broker/ffmpeg-invocation.ts',
    'broker ADAPTER — `buildBrokerEgressArgs` delegates to the shared builder',
  ],
]

function isBuilderAllowlisted(relative: string): boolean {
  return BUILDER_ALLOWLIST.some(([entry]) => entry === relative)
}

interface Violation {
  readonly file: string
  readonly line: number
  readonly content: string
  readonly rule: string
}

function isAllowlisted(relative: string): boolean {
  return SPAWN_ALLOWLIST.some(([entry]) => entry === relative)
}

function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * `export function build…FfmpegArgs` / `build…TranscodeArgs`. A `…DecodeArgs`
 * name is excluded by construction: decode is a different job with a different
 * owner (the decoder addon), and the primitive consults it rather than
 * replacing it.
 */
const BUILDER_RE = /export\s+(?:async\s+)?function\s+(build\w*(?:Ffmpeg|Transcode)\w*Args)\s*[(<]/
/** A spawn/exec whose binary expression mentions ffmpeg. */
const FFMPEG_SPAWN_RE =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execFileAsync)\s*\(\s*[^,)]*ffmpeg[^,)]*[,)]/i
/** A cap method taking a handle AND encode parameters — a mutable shared handle. */
const MUTABLE_HANDLE_RE = /pipelineKey/
const ENCODE_PARAM_RE = /\bencode:|EgressEncodeSchema|EncodeProfileSchema|bitrateKbps|rateControl/

function walk(dir: string, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      walk(p, out)
    } else if (/\.tsx?$/.test(entry) && !/\.(spec|test|d)\.tsx?$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

const violations: Violation[] = []

for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(scanRoot)) {
    const relative = path.relative(ROOT, file)
    const inPrimitive = file.startsWith(PRIMITIVE_DIR)
    const lines = readFileSync(file, 'utf8').split('\n')

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!
      if (isCommentLine(raw)) continue
      const lineNo = i + 1

      // Rule 1 — one argv builder.
      const builder = BUILDER_RE.exec(raw)
      if (
        builder &&
        !inPrimitive &&
        !isBuilderAllowlisted(relative) &&
        !(builder[1] ?? '').endsWith('DecodeArgs')
      ) {
        violations.push({
          file: relative,
          line: lineNo,
          content: raw.trim(),
          rule: `Rule 1: a SECOND argv builder (\`${builder[1]}\`). Compose \`buildFfmpegArgs\` from @camstack/types instead.`,
        })
      }

      // Rule 2 — no ffmpeg spawn outside the primitive.
      if (FFMPEG_SPAWN_RE.test(raw) && !inPrimitive && !isAllowlisted(relative)) {
        violations.push({
          file: relative,
          line: lineNo,
          content: raw.trim(),
          rule: 'Rule 2: ffmpeg spawned outside the primitive. Use `FfmpegProcess` from @camstack/types/node, or add an allowlist entry WITH its reason.',
        })
      }
    }

    // Rule 3 — a shared handle is immutable. Scoped to cap definitions: a
    // method input carrying a `pipelineKey` may carry NOTHING else that
    // describes an encode.
    if (file.endsWith('.cap.ts')) {
      // Scoped to ONE method's declaration: `name: method(<input>, <output>…)`.
      // Splitting the whole file would flag any cap that merely mentions both
      // concepts anywhere, which is not the rule.
      const src = lines.join('\n')
      for (const m of src.matchAll(/^ {4}(\w+): method\(([\s\S]*?)\n {4}\),$/gm)) {
        const name = m[1] ?? ''
        const body = m[2] ?? ''
        if (!MUTABLE_HANDLE_RE.test(body)) continue
        if (!ENCODE_PARAM_RE.test(body)) continue
        violations.push({
          file: relative,
          line: src.slice(0, m.index ?? 0).split('\n').length,
          content: `${name}: method(…)`,
          rule: 'Rule 3: a cap method takes a pipelineKey AND encode parameters — that is a MUTABLE shared handle. Release and re-acquire instead.',
        })
      }
    }
  }
}

if (violations.length === 0) {
  console.log('check-ffmpeg-primitive: OK')
  process.exit(0)
}

console.error('\n\x1b[31m✘ ffmpeg-primitive violations:\x1b[0m')
console.error(
  '  Every live-media ffmpeg is built by ONE argv builder\n' +
    '  (packages/types/src/ffmpeg/invocation.ts) and spawned by ONE lifecycle\n' +
    '  wrapper (packages/types/src/ffmpeg/process.ts). See docs/decisions/adr-0067.md.\n',
)
for (const v of violations) {
  console.error(`    ${v.file}${v.line > 0 ? `:${v.line}` : ''}  ${v.rule}`)
  console.error(`      \x1b[2m${v.content}\x1b[0m`)
}
console.error('')
process.exit(1)
