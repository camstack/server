/**
 * `check-no-bare-ffmpeg` — which source shapes reach ffmpeg/ffprobe through
 * PATH (D540), and which merely mention the name.
 *
 * The first case is the one that shipped: the timelapse preview's
 * `ports.ffmpegPath ?? 'ffmpeg'`, whose caller never passed a path.
 */
import { describe, expect, it } from 'vitest'
import { findBareFfmpeg, stripComments } from '../check-no-bare-ffmpeg.js'

const rules = (src: string): readonly string[] => findBareFfmpeg(src).map((f) => f.rule)

describe('what reaches PATH', () => {
  it('refuses the timelapse preview as it shipped: an optional path defaulting to the name', () => {
    expect(
      rules(
        [
          "  const ffmpeg = ports.ffmpegPath ?? 'ffmpeg'",
          "  const ffprobe = ports.ffprobePath ?? 'ffprobe'",
        ].join('\n'),
      ),
    ).toEqual(['path-default', 'path-default'])
  })

  it('refuses a spawn by name, on one line or across several', () => {
    expect(rules("const proc = spawn('ffmpeg', args)")).toEqual(['bare-spawn'])
    expect(rules("execFileSync('ffprobe', ['-v', 'error'])")).toEqual(['bare-spawn'])
    expect(rules("const child = execFile(\n      'ffmpeg',\n      ['-i', url],\n)")).toEqual([
      'bare-spawn',
    ])
  })

  it('refuses a binary binding that holds the bare name', () => {
    expect(rules("  private ffmpegBinaryPath = 'ffmpeg'")).toEqual(['bare-binding'])
    expect(rules("const FFMPEG_BINARY = 'ffmpeg'")).toEqual(['bare-binding'])
    expect(rules("  binaryPath: 'ffmpeg',")).toEqual(['bare-binding'])
    expect(rules("  ffmpegPath: string = 'ffmpeg',")).toEqual(['bare-binding'])
  })

  it('refuses the wrapper packages whose default is PATH or an unpinned build', () => {
    expect(rules("import ffmpeg from 'fluent-ffmpeg'")).toEqual(['unpinned-package'])
    expect(rules("const p = require('ffmpeg-static')")).toEqual(['unpinned-package'])
  })
})

describe('the shapes review found evading the first version (fix round 1)', () => {
  it('refuses an injected spawn — any callee named for spawn/exec', () => {
    expect(rules("input.spawnFn('ffmpeg', [...args])")).toEqual(['bare-spawn'])
    expect(rules("const child = deps.spawnMux('ffprobe', args)")).toEqual(['bare-spawn'])
    expect(rules("await execFileAsync('ffmpeg', ['-version'])")).toEqual(['bare-spawn'])
  })

  it('refuses a command LINE, quoted or templated', () => {
    expect(rules("execSync('ffmpeg -version')")).toEqual(['bare-spawn'])
    expect(rules('await execAsync(`ffprobe -v error ${url}`)')).toEqual(['bare-spawn'])
  })

  it('refuses a ternary whose else is the bare name — as a path binding or a spawn argument', () => {
    expect(rules("const bin = p !== undefined ? p : 'ffmpeg'")).toEqual(['ternary-default'])
    expect(rules("const ffmpegPath = override ? override : 'ffmpeg'")).toEqual(['ternary-default'])
    expect(rules("spawn(p !== undefined ? p : 'ffprobe', args)")).toEqual(['ternary-default'])
  })

  it('passes a ternary LABEL — it names an engine, not a binary', () => {
    expect(rules("const label = isFf ? 'native' : 'ffmpeg'")).toEqual([])
    expect(rules("  engine: parser === undefined ? 'native' : 'ffmpeg',")).toEqual([])
    expect(rules("return useFfmpeg ? 'ffmpeg' : 'native'")).toEqual([])
  })

  it("refuses the host's binary by absolute path", () => {
    expect(rules("spawn('/usr/bin/ffmpeg', args)")).toEqual(['absolute-host-path'])
    expect(rules("const probe = '/usr/local/bin/ffprobe'")).toEqual(['absolute-host-path'])
  })

  it('refuses a binding NAMED for the binary', () => {
    expect(rules("const FFMPEG = 'ffmpeg'")).toEqual(['bare-binding'])
  })

  it('still passes optional chaining, nullish on a non-binary, and comparisons', () => {
    expect(rules("opts.onDemuxPath?.({ path: 'ffmpeg', reason: 'x' })")).toEqual([])
    expect(rules("const f = a?.b ?? 'tar.xz'")).toEqual([])
    expect(rules("if (ffmpegEngine === 'ffmpeg') return")).toEqual([])
    expect(rules("const engine = parser ? 'native' : 'ffmpeg-parser'")).toEqual([])
  })
})

describe('what only mentions the name', () => {
  it('passes a resolved path', () => {
    expect(rules('const proc = spawn(deps.ffmpegPath, args)')).toEqual([])
    expect(rules('const ffmpeg = await ports.resolveFfmpeg()')).toEqual([])
  })

  it('passes a demux-path TAG and a decoder id — neither is a binary', () => {
    expect(rules("opts.onDemuxPath?.({ path: 'ffmpeg', reason: 'x' })")).toEqual([])
    expect(rules("  readonly id = 'ffmpeg'")).toEqual([])
    expect(rules("if (backend !== 'ffmpeg') return")).toEqual([])
  })

  it('ignores comments that QUOTE the old pattern', () => {
    expect(rules("// used to spawn('ffmpeg') per resize\nconst x = 1")).toEqual([])
    expect(rules("/**\n * defaults to `ffmpeg` on PATH: ffmpegPath ?? 'ffmpeg'\n */")).toEqual([])
  })

  it('keeps a string that contains `//` whole, and line numbers stable', () => {
    const src = "const url = 'rtsp://cam'\n/* one\n two */\nspawn('ffmpeg', [])"
    expect(stripComments(src).split('\n')).toHaveLength(4)
    expect(findBareFfmpeg(src)).toEqual([
      { rule: 'bare-spawn', line: 4, text: "spawn('ffmpeg', [])" },
    ])
  })
})
