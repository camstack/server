/**
 * The composition as processes: one decoder per tile, one encoder, one tick.
 *
 * It presents the SAME shape the single ffmpeg did — `{ stdout, stop }` — so
 * `GridStreamSession` is untouched. The seam is deliberate: the session owns
 * demand, acquisition and teardown, and none of that changes because the
 * picture is assembled differently.
 *
 * ## The order things start in, and why it is the order
 *
 * The seed first, then the encoder, then the tick, then the decoders. The tick
 * writes the canvas from its very first beat, so the encoder produces a stream
 * — and the consumer sees a picture — before any camera has delivered anything.
 * That is the cold start the old shape spent waiting for the slowest source's
 * first key frame, and it is now spent watching cells fill in.
 *
 * What that first picture SAYS is the seed (`grid-canvas-seed.ts`): one card
 * per cell, at the cell's own rectangle, naming its camera. It is drawn once,
 * here, before the compositor is built — a tick must never wait on a render —
 * and it is bounded and fallible: a seed that cannot be drawn leaves the canvas
 * black, which is what it was before, and never stops the composition.
 *
 * ## Back-pressure is a SKIPPED tick, never a queue
 *
 * A raw canvas frame is 3.1 MB at 1080p. If the encoder stops draining, the one
 * safe thing is to stop composing until it drains again: a queue of raw frames
 * is how a stalled encoder becomes an OOM, and a dropped frame in a live
 * composite costs nothing anybody can see.
 *
 * ## A tile comes back; only the ENCODER ends the composition
 *
 * Every child exiting used to end it, on the reasoning that a frozen tile is a
 * nicer picture and a worse fact. In practice it produced neither: a 4K source
 * ended mid-run (`code=0` — the input simply finished), the composition tore
 * down, the consumer re-dialled, and the grid served nothing but restarts. That
 * is what the operator saw as the `auto` rung being stuck.
 *
 * A canvas makes the better answer cheap: while a decoder comes back, its cell
 * holds the last frame it produced and every other cell carries on. The bound
 * (`TILE_MAX_RESTARTS`) keeps a source that is genuinely gone from respawning
 * for ever — and when it is reached, the composition does end, with the tile
 * named.
 *
 * The encoder is different: nothing downstream of it exists without it, so its
 * exit is the composition's exit, first time.
 */
import { buildFfmpegArgs, errMsg } from '@camstack/types'
import { FfmpegProcess } from '@camstack/types/node'
import type { Writable } from 'node:stream'
import { buildGridSeedSpec, renderGridSeed } from './grid-canvas-seed.js'
import { GridCompositor } from './grid-compositor.js'
import {
  gridCanvasEncoderInvocation,
  gridTileDecoderInvocation,
} from './grid-compositor-invocation.js'
import { buildGridTilePlan, type GridTile, type GridTilePlan } from './grid-tile-plan.js'
import type { GridChildContext } from './grid-child.js'
import type { GridSourceHandle, GridStreamChild, GridStreamPlan } from './grid-stream-session.js'

/**
 * The encoder must produce its first bytes quickly, because the tick feeds it a
 * black canvas immediately — a silence here is the encoder failing to start,
 * not a camera being slow.
 */
const ENCODER_FIRST_DATA_MS = 5_000
/**
 * A decoder's first frame waits for its source's next key frame, which on this
 * fleet is up to a GOP. Generous, and it costs only that tile: the picture is
 * already on screen.
 */
const DECODER_FIRST_DATA_MS = 15_000
/**
 * How many times a tile's decoder may come back before the composition gives up
 * on it.
 *
 * The bound exists so a source that is genuinely gone still ends the
 * composition rather than respawning for ever; below it, a decoder that dies is
 * simply replaced while its cell holds the last frame it produced.
 */
const TILE_MAX_RESTARTS = 5
/**
 * How long the seed may wait for the source cameras' names.
 *
 * The seed is drawn BEFORE the encoder is spawned — that is what puts it on the
 * first tick — so everything it waits for is added to the cold start the rest
 * of this file exists to keep short. A name is a nicety; the card exists
 * either way, labelled by device id. So the read is bounded and the deadline
 * is not an error.
 */
const SEED_NAMES_TIMEOUT_MS = 1_500

/**
 * The names for the cards, or an empty map.
 *
 * Never throws and never delays past the deadline: an unnamed card is a
 * complete card (`gridSeedName` falls back to the device id), and a grid that
 * started late because a name lookup was slow would be a worse grid.
 */
async function resolveSeedNames(
  ctx: GridChildContext,
  deviceIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolve = ctx.resolveSourceNames
  if (resolve === undefined) return new Map()
  const empty: ReadonlyMap<number, string> = new Map()
  return new Promise<ReadonlyMap<number, string>>((settle) => {
    const timer = setTimeout(() => {
      ctx.logger.warn('camera grid: the seed could not read the source names in time', {
        tags: { deviceId: ctx.deviceId },
        meta: { sources: deviceIds.length, timeoutMs: SEED_NAMES_TIMEOUT_MS },
      })
      settle(empty)
    }, SEED_NAMES_TIMEOUT_MS)
    timer.unref()
    resolve(deviceIds).then(
      (names) => {
        clearTimeout(timer)
        settle(names)
      },
      (error: unknown) => {
        clearTimeout(timer)
        ctx.logger.warn('camera grid: the seed could not read the source names', {
          tags: { deviceId: ctx.deviceId },
          meta: { sources: deviceIds.length, error: errMsg(error) },
        })
        settle(empty)
      },
    )
  })
}

/**
 * The picture the canvas starts as: one card per cell, naming its camera.
 *
 * `null` — black, which is what this was before — when it cannot be drawn. A
 * placeholder that refused to render must never be the reason a grid does not
 * start, so every failure here is a warning and a composition that carries on.
 */
async function buildCanvasSeed(
  ctx: GridChildContext,
  tilePlan: GridTilePlan,
): Promise<Buffer | null> {
  const deviceIds = [...new Set(tilePlan.tiles.map((tile) => tile.deviceId))]
  const names = await resolveSeedNames(ctx, deviceIds)
  try {
    return await renderGridSeed(buildGridSeedSpec(tilePlan, names))
  } catch (error) {
    ctx.logger.warn('camera grid: the canvas seed could not be drawn - starting black', {
      tags: { deviceId: ctx.deviceId },
      meta: { error: errMsg(error), tiles: tilePlan.tiles.length },
    })
    return null
  }
}

export async function startGridCompositorChild(
  ctx: GridChildContext,
  plan: GridStreamPlan,
  sources: readonly GridSourceHandle[],
  onEnded: (reason: string) => void,
): Promise<GridStreamChild> {
  const tilePlan = buildGridTilePlan({
    canvas: { width: plan.layout.width, height: plan.layout.height },
    cells: plan.layout.cells.map((cell) => ({
      deviceId: plan.sourceDeviceIds[cell.inputIndex] ?? 0,
      source: cell.source,
      cell: cell.cell,
    })),
  })
  if (tilePlan.tiles.length === 0) {
    throw new Error('camera-grid: every cell rounded away to nothing — there is no picture to make')
  }

  let ended = false
  const end = (reason: string): void => {
    if (ended) return
    ended = true
    onEnded(reason)
  }

  // ── The composition ──────────────────────────────────────
  //
  // Built BEFORE the encoder is spawned, and its tick started the moment the
  // encoder's stdin exists — which is inside `onChild`, not after `start()`.
  //
  // The obvious order (start the encoder, then begin composing) DEADLOCKS, and
  // it did, on the hub: `start()` waits for the child's first OUTPUT, and the
  // encoder cannot produce any until something writes the canvas in. It died on
  // its first-data timeout every time, with an empty stderr because ffmpeg had
  // nothing to complain about. The local smoke test missed it by spawning
  // ffmpeg directly — so the first-data gate, which is what the deadlock is
  // against, was the one part that had never run.
  // Drawn BEFORE the compositor exists, so the canvas carries the layout from
  // the first tick and the tick itself never waits on a render.
  const seed = await buildCanvasSeed(ctx, tilePlan)

  let encoderIn: Writable | null = null
  let encoderOut: GridStreamChild['stdout'] | null = null
  let draining = false
  let tick: ReturnType<typeof setInterval> | null = null
  const compositor = new GridCompositor({
    plan: tilePlan,
    seed,
    write: (frame) => {
      const sink = encoderIn
      // Before the child exists there is nowhere to put it. Not an error: the
      // next tick has a sink, and a dropped black frame is invisible.
      if (sink === null || draining || sink.destroyed) return false
      // `write` answers false when the pipe has not taken it. Honour it: the
      // next tick is skipped until `drain`, which is the only bound on how much
      // raw video this process can hold.
      const accepted = sink.write(frame)
      if (!accepted) draining = true
      return accepted
    },
  })
  const startTick = (): void => {
    if (tick !== null) return
    tick = setInterval(
      () => {
        compositor.tick()
      },
      Math.max(1, Math.round(1000 / plan.fps)),
    )
    // The tick must never be the reason a node cannot exit.
    tick.unref()
  }

  // ── The encoder ──────────────────────────────────────────
  const encoder = new FfmpegProcess({
    binaryPath: ctx.binaryPath,
    buildArgs: () =>
      buildFfmpegArgs(
        gridCanvasEncoderInvocation({
          canvas: tilePlan.canvas,
          fps: plan.fps,
          encoder: plan.encoder,
          bitrateKbps: plan.bitrateKbps,
        }),
      ),
    decodeHwAccel: null,
    logger: ctx.logger.child('encode'),
    deviceId: ctx.deviceId,
    role: 'camera-grid-encode',
    tags: { tiles: tilePlan.tiles.length },
    firstDataTimeoutMs: ENCODER_FIRST_DATA_MS,
    maxRestarts: 0,
    stdio: ['pipe', 'pipe', 'pipe'],
    onChild: (child) => {
      encoderIn = child.stdin
      if (child.stdout) encoderOut = child.stdout
      child.stdin?.on('drain', () => {
        draining = false
      })
      // The black canvas starts flowing NOW, so the encoder has something to
      // encode before its first-data deadline — and so the grid appears before
      // any camera has delivered a frame.
      startTick()
      // The primitive keeps the stderr tail; draining here is what stops a full
      // pipe buffer freezing ffmpeg.
      child.stderr?.on('data', () => {})
      // A write to a dead encoder must not take the addon down with an
      // unhandled EPIPE; the exit path already reports the real reason.
      child.stdin?.on('error', () => {})
    },
    onExit: (exit) => end(`encoder:${exit.classification}`),
  })
  try {
    await encoder.start()
  } catch (error) {
    if (tick !== null) clearInterval(tick)
    compositor.close()
    throw error
  }
  if (encoderIn === null || encoderOut === null) {
    await encoder.stop()
    throw new Error('camera-grid: the canvas encoder exposed no stdin/stdout to compose into')
  }

  // ── One decoder per tile ─────────────────────────────────
  const urlByDeviceId = new Map<number, string>()
  for (const [index, deviceId] of plan.sourceDeviceIds.entries()) {
    const url = sources[index]?.url
    if (url !== undefined) urlByDeviceId.set(deviceId, url)
  }

  const decoders: FfmpegProcess[] = []
  const startDecoder = async (tile: GridTile): Promise<void> => {
    const url = urlByDeviceId.get(tile.deviceId)
    if (url === undefined) {
      throw new Error(`camera-grid: no acquired source for device ${String(tile.deviceId)}`)
    }
    const decoder = new FfmpegProcess({
      binaryPath: ctx.binaryPath,
      buildArgs: () => buildFfmpegArgs(gridTileDecoderInvocation({ tile, url, fps: plan.fps })),
      decodeHwAccel: null,
      logger: ctx.logger.child('tile'),
      // The SOURCE camera, so every line about this tile is asked about the
      // right device — the composite's id is on the encoder's lines.
      deviceId: tile.deviceId,
      role: 'camera-grid-tile',
      tags: { tile: tile.id, width: tile.size.width, height: tile.size.height },
      firstDataTimeoutMs: DECODER_FIRST_DATA_MS,
      // A tile comes back on its own. Only the ENCODER ending is the end of
      // the composition — see `TILE_MAX_RESTARTS`.
      maxRestarts: TILE_MAX_RESTARTS,
      onChild: (child) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          compositor.onTile(tile.id, chunk)
        })
        child.stderr?.on('data', () => {})
      },
      onExit: () => {
        // The half frame the dead decoder left behind must go, or the new
        // one's bytes land misaligned and every frame after is sheared. The
        // cell keeps its last WHOLE frame, so it freezes rather than blinks.
        compositor.resetTile(tile.id)
      },
      // Fires only once the wrapper has stopped restarting for good.
      onGiveUp: (error) => end(`tile ${tile.id}: ${error.message}`),
    })
    decoders.push(decoder)
    await decoder.start()
  }

  const stopAll = async (): Promise<void> => {
    if (tick !== null) clearInterval(tick)
    compositor.close()
    await Promise.allSettled(decoders.map((d) => d.stop()))
    await encoder.stop()
  }

  try {
    // Sequentially, so a failure names the tile that failed rather than
    // arriving as one rejected batch of N.
    for (const tile of tilePlan.tiles) await startDecoder(tile)
  } catch (error) {
    await stopAll()
    throw error
  }

  ctx.logger.info('camera grid: composing on an output clock', {
    tags: { deviceId: ctx.deviceId },
    meta: {
      tiles: tilePlan.tiles.length,
      canvas: `${String(tilePlan.canvas.width)}x${String(tilePlan.canvas.height)}`,
      fps: plan.fps,
      // Said out loud: a composition that started BLACK looks identical to a
      // seeded one the moment the tiles land, and the difference is only
      // visible in the seconds nobody is watching the log for.
      seeded: seed !== null,
    },
  })

  return { stdout: encoderOut, stop: stopAll }
}
