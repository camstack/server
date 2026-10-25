import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ManifestExecution {
  readonly heapProfile?: string
  readonly maxOldSpaceMb?: number
  readonly rssBudgetMb?: number
  readonly semiSpaceMb?: number
  readonly initialOldSpaceMb?: number
}
interface ManifestAddonEntry {
  readonly id?: string
  readonly execution?: ManifestExecution
}
interface PackageManifest {
  readonly camstack?: { readonly addons?: readonly ManifestAddonEntry[] }
}

/**
 * The media-path runners' old-space ceilings, and the measurements each number
 * comes from.
 *
 * ## What `maxOldSpaceMb: 0` was for, and why it is no longer right
 *
 * Every addon here declared `maxOldSpaceMb: 0` (uncapped) on 2026-08-17, after a
 * FLAT 1024MB cap across the whole media path turned a disk-stall backlog into
 * `Ineffective mark-compacts near heap limit` and killed recording twice. That
 * record diagnosed the wrong cause: 1024MB was not "a cap", it was a cap set
 * BELOW the recorder's normal working set. The `[mem]` heartbeats show the
 * recorder living at up to 1647MB heapUsed — a 1024MB ceiling was never
 * survivable, and the other three addons on that path were never anywhere near
 * it.
 *
 * `0` did not remove a ceiling either. It selected V8's host-derived default,
 * measured here as **4288MB** — a number nothing in this repo chose, that moves
 * with host RAM, and that is far above every one of these processes' real
 * working set.
 *
 * ## The measurements (live hub, ~6h of `[mem]` heartbeats, 2026-08-25)
 *
 *   runner          peak rss   peak heapUsed   peak heapTotal
 *   recorder          2471MB          1647MB          2341MB
 *   stream-broker     1585MB           105MB           224MB
 *   detection          627MB           114MB           202MB
 *   audio-analyzer     240MB           118MB           199MB
 *
 * Note what the RSS column does NOT say about the heap: `stream-broker` reaches
 * 1585MB RSS on a 224MB heap because ~1GB of it is `arrayBuffers` (47 RTP
 * rings), which `--max-old-space-size` does not bound and never will. The
 * ceiling is a bound on runaway OLD SPACE, not a lever on these processes' RSS.
 *
 * ## The rule
 *
 * Three of the four hold an incidental heap (peak heapTotal < 256MB) and take
 * the heavy CLASS DEFAULT, which yields an effective V8 heapLimit of 1216MB —
 * a ≥5.4x margin over anything ever observed. The recorder, which owns a real
 * data structure (the recordings index), declares its own: 3072MB, an effective
 * limit of 3264MB = 1.39x its peak heapTotal and 1.98x its peak heapUsed, while
 * still sitting 1024MB below the V8 default it replaces.
 */
describe('addon-pipeline media-path heap ceilings', () => {
  const manifestPath = join(__dirname, '..', '..', 'package.json')
  const manifest: PackageManifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as PackageManifest
  const entry = (id: string): ManifestAddonEntry | undefined =>
    manifest.camstack?.addons?.find((a) => a.id === id)

  const CLASS_DEFAULT_IDS = [
    'pipeline-runner',
    'detection-pipeline',
    'motion-wasm',
    'audio-analyzer',
    'stream-broker',
  ] as const

  it.each(
    CLASS_DEFAULT_IDS,
  )('%s takes the heavy CLASS DEFAULT ceiling — its heap is incidental (peak heapTotal < 256MB)', (id) => {
    const e = entry(id)
    expect(e, `${id} missing from the manifest`).toBeDefined()
    expect(e?.execution?.heapProfile).toBe('heavy')
    expect(e?.execution?.maxOldSpaceMb).toBeUndefined()
  })

  /**
   * The one number on this path that had to be measured rather than inherited.
   * It is deliberately NOT the class default: 1024MB is the exact value that
   * killed recording twice on 2026-08-17, because the recorder's own working
   * set peaks at 1647MB heapUsed / 2341MB heapTotal during the deferred archive
   * walk (99,809 segments). Leaving `maxOldSpaceMb` off here would silently
   * reinstate that failure.
   */
  it('recorder declares its own 3072MB — the class default is the value that killed it', () => {
    const e = entry('recorder')
    expect(e?.execution?.heapProfile).toBe('heavy')
    expect(e?.execution?.maxOldSpaceMb).toBe(3072)
  })

  it('no addon on this path is left uncapped — `0` selects V8 s 4288MB host default, not "no ceiling"', () => {
    for (const a of manifest.camstack?.addons ?? []) {
      expect(a.execution?.maxOldSpaceMb, `${a.id ?? '?'} is uncapped`).not.toBe(0)
    }
  })

  /**
   * ## The two addons here whose FULL footprint has been measured
   *
   * `maxOldSpaceMb` bounds V8's old space and nothing else, so it cannot be the
   * number the memory watchdog alarms on: `hub/pipeline-analytics` was killed at
   * 11.4GB with its ceiling in force and 96% of the growth outside V8. RSS is
   * what the host's OOM killer reads, so RSS is what carries a declared budget —
   * and only where a measurement exists. A budget guessed for an unprofiled
   * addon would cry wolf, and a watchdog that cries wolf gets muted.
   */
  it('recorder budgets 3584MB RSS — its 3072MB old space plus its own native floor', () => {
    // Measured 2026-08-27: 1509.8MB in V8 s 256KB page ranges against 53.9MB of
    // glibc `brk` and `external` at 8MB. This runner is almost entirely V8, so
    // its budget is its declared ceiling plus a small native margin — anything
    // materially above that is not the segment index.
    expect(entry('recorder')?.execution?.rssBudgetMb).toBe(3584)
  })

  it('stream-broker budgets 2048MB RSS — a bound its 224MB old space could never give it', () => {
    // Measured 2026-08-27: 242.6MB in V8 pages but 1159.1MB of glibc `brk`, with
    // `arrayBuffers` at 829MB — 47 RTP pre-roll rings. Its old space peaks at
    // 224MB, so the class-default ceiling is 4.5x its real heap and blind to the
    // ~1GB that actually moves. Peak RSS observed 1585MB; 2048 clears it.
    expect(entry('stream-broker')?.execution?.rssBudgetMb).toBe(2048)
    // …and it deliberately still takes the class-default HEAP ceiling: the two
    // numbers bound different things and neither substitutes for the other.
    expect(entry('stream-broker')?.execution?.maxOldSpaceMb).toBeUndefined()
  })

  /**
   * ## 2026-08-27, second pass: two more of these runners now HAVE a measurement
   *
   * The first pass left every addon on this path unwatched because nothing had
   * been profiled. `[mem]` samples taken the same day under an active load (two
   * cameras open in live view — not at rest) closed that gap for two of them:
   *
   *   runner           rss     heapUsed   external   earlier peak (2026-08-25)
   *   detection       553MB     121MB       14MB           627MB
   *   audio-analyzer  176MB     105MB       13MB           240MB
   *
   * The multiplier is not a constant, and it is not taste: it comes from how far
   * the sample is from the role's LOADED state, which the shares reveal. A
   * sample carrying real `external` caught the process doing its job and needs
   * little headroom; a sample that is mostly V8 heap with single-digit
   * `external` caught it idle, and the budget must then be sized from the role
   * rather than from the number on the screen.
   */
  it('detection budgets 1536MB RSS — it holds frames AND weights in-process by design', () => {
    // The `detection` group exists precisely so frames do NOT cross a process
    // boundary (D9/D18), so decoded frames and loaded detector weights are its
    // legitimate working set. 627MB peak already includes one model resident;
    // 1536 covers a second engine or a larger input size — the step this
    // runner's footprint actually moves in — and still bites 7.4x below the
    // 11.4GB that killed the host. 2048 would put it level with stream-broker,
    // which legitimately parks ~1GB of RTP rings; this runner has no such
    // structure, so 2048 is a budget it could never reach and therefore never
    // a warning.
    expect(entry('detection-pipeline')?.execution?.rssBudgetMb).toBe(1536)
    // It is declared on the member whose ROLE sets the number. The runner takes
    // the MAX across the group, so `pipeline-runner` and `motion-wasm` are
    // watched by this one without inventing numbers for them.
    expect(entry('pipeline-runner')?.execution?.rssBudgetMb).toBeUndefined()
    expect(entry('motion-wasm')?.execution?.rssBudgetMb).toBeUndefined()
  })

  it('audio-analyzer budgets 512MB RSS — the number here has to stay SMALL to mean anything', () => {
    // 60% of its RSS is V8 heap and `external` is 13MB: audio, and nothing else.
    // A second of 16-bit 16kHz mono PCM is 32KB, so even a generous per-camera
    // ring across the whole fleet is single-digit MB. Handing this process a
    // frame-shaped budget would make it unwatched in practice — 512MB is 2.1x
    // its observed peak and still an absurd size for PCM metering, which is
    // exactly the point: if it gets there, something is retaining audio.
    expect(entry('audio-analyzer')?.execution?.rssBudgetMb).toBe(512)
  })

  /**
   * ## 2026-10-15: the broker's heap is SHAPED, not only ceilinged
   *
   * The class-default ceiling above is right for `stream-broker` and so is the
   * heavy class's 64 MB young generation — for every other heavy runner. The
   * broker is the one process here whose live old space is small (~100 MB)
   * while its allocation rate is enormous (~11 k RTP packets/s, 47 sources):
   * V8 sizes the old-space headroom after a mark-compact from the live set, that
   * headroom sat BELOW the young generation, so every scavenge promoted enough to
   * restart incremental marking. Measured on a reproduction of the hub's load
   * (47 brokers, 115 Mbps, 38 RTSP clients):
   *
   *   flags                                     majors/min  scavenges/min  CPU     GC pause/5 min
   *   class default                                 232.5        0.0       61.9 %  1 886 ms
   *   semiSpaceMb 8 + initialOldSpaceMb 512          21.0      223.5       20.7 %    102 ms
   *   semiSpaceMb 8 + initialOldSpaceMb 256          33.0      222.0       36.0 %  1 377 ms
   *
   * 512 over 256 because the pause and the CPU halve again; the ~330 MB of RSS it
   * reserves is old-space headroom the 2048 MB budget above already allows for.
   * The flags must be on the spawn argv (`runnerHeapFlags`): `v8.setFlagsFromString`
   * at runtime moves neither space.
   */
  it('stream-broker declares an 8MB semi-space and a 512MB initial old space — the measured remedy for 232 majors/min', () => {
    expect(entry('stream-broker')?.execution?.semiSpaceMb).toBe(8)
    expect(entry('stream-broker')?.execution?.initialOldSpaceMb).toBe(512)
  })

  it('no other addon shapes its young generation or initial old space — nothing new for the other runners', () => {
    for (const a of manifest.camstack?.addons ?? []) {
      if (a.id === 'stream-broker') continue
      expect(a.execution?.semiSpaceMb, `${a.id ?? '?'} declares semiSpaceMb`).toBeUndefined()
      expect(
        a.execution?.initialOldSpaceMb,
        `${a.id ?? '?'} declares initialOldSpaceMb`,
      ).toBeUndefined()
    }
  })

  it('an addon with no measured footprint declares NO budget — unwatched beats invented', () => {
    // These are reported "NOT WATCHED" at boot by `startRunnerHeapWatch`, which
    // is the honest state. Inventing a number for them would be the same defect
    // in a new place. `pipeline-runner` and `motion-wasm` are NOT in this list
    // by accident — they are covered by their group-mate above, which is a
    // different thing from carrying a number nobody measured.
    for (const id of ['pipeline-runner', 'motion-wasm']) {
      expect(entry(id)?.execution?.rssBudgetMb, `${id} has an unmeasured budget`).toBeUndefined()
    }
  })
})
