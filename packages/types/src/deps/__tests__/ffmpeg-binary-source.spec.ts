/**
 * WHICH ffmpeg a node runs. One answer, on every node, and never the host's.
 *
 * The rule went through three shapes in two days and this is the one that
 * holds. First the resolution was `deps dir → system PATH → download`, so the
 * binary every transcode ran through was whatever the host happened to have —
 * unknown version, unknown vendor libraries, changing on any host update
 * (D536). Then the container image installed one and CamStack preferred it,
 * which fixed the hub and made the answer depend on where the node ran: an
 * image node got VAAPI and a native one got a portable build with none.
 *
 * Now it is uniform: **every node downloads the same pinned build**, the
 * version is the framework's to state, and the image ships no ffmpeg at all.
 * Three things follow, and all three were the point:
 *
 *  - the version becomes DATA, not code — changing it is a framework bump, not
 *    an image rebuild;
 *  - we ship no ffmpeg binary, so we convey no GPL work: the user's own node
 *    fetches it from the project that publishes it;
 *  - one artifact per platform+arch, with the hardware it is supposed to carry
 *    written down next to it, so a source that changes under us is caught by
 *    the probe instead of discovered months later in a log nobody reads.
 *
 * `CAMSTACK_FFMPEG_PATH` remains, and beats everything: an operator who points
 * at their own build has said something deliberate.
 */
import { describe, expect, it } from 'vitest'
import { FFMPEG_PATH_ENV, chooseFfmpegBinary, ffmpegBinaryName } from '../ffmpeg-binary-source.js'
import { FFMPEG_RELEASE, getFfmpegArtifact } from '../ffmpeg-artifacts.js'

const PINNED = `/data/deps/${ffmpegBinaryName('linux')}`

function choose(present: readonly string[], platform = 'linux', override?: string) {
  return chooseFfmpegBinary({
    platform,
    pinnedPath: PINNED,
    override: override ?? null,
    exists: (path) => present.includes(path),
  })
}

describe('chooseFfmpegBinary', () => {
  it('uses the pinned build this node has already downloaded', () => {
    expect(choose([PINNED])).toEqual({ origin: 'downloaded', path: PINNED })
  })

  it('asks for a download when the pinned build is not there yet', () => {
    expect(choose([])).toBeNull()
  })

  it("never answers with the host's ffmpeg, whatever is lying around", () => {
    expect(choose(['/usr/bin/ffmpeg', '/opt/camstack/bin/ffmpeg'])).toBeNull()
  })

  it('honours an operator override above everything', () => {
    expect(choose([PINNED, '/opt/mine/ffmpeg'], 'linux', '/opt/mine/ffmpeg')).toEqual({
      origin: 'override',
      path: '/opt/mine/ffmpeg',
    })
  })

  it('falls back to the pinned build when the override names nothing — a typo must not stop video', () => {
    expect(choose([PINNED], 'linux', '/opt/typo/ffmpeg')?.origin).toBe('downloaded')
  })

  it('treats an empty override as unset', () => {
    expect(choose([PINNED], 'linux', '   ')?.origin).toBe('downloaded')
  })

  it('names the env var it reads, so the log can quote it', () => {
    expect(FFMPEG_PATH_ENV).toBe('CAMSTACK_FFMPEG_PATH')
  })
})

describe('ffmpegBinaryName', () => {
  it('carries the pinned release, so two versions can coexist across a change', () => {
    expect(ffmpegBinaryName('linux')).toContain(FFMPEG_RELEASE)
    expect(ffmpegBinaryName('win32').endsWith('.exe')).toBe(true)
  })
})

describe('getFfmpegArtifact', () => {
  it('has one artifact per platform AND arch — an Intel Mac never gets the arm build', () => {
    const intel = getFfmpegArtifact('darwin', 'x64')
    const arm = getFfmpegArtifact('darwin', 'arm64')
    expect(intel.url).not.toBe(arm.url)
    expect(intel.url).toContain('mac64')
    expect(arm.url).toContain('macarm64')
  })

  it('pins a checksum for every artifact — the download is the only source now', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
    ] as const) {
      expect(getFfmpegArtifact(platform, arch).sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('states the hardware each build is supposed to carry', () => {
    // Verified by EXECUTION on 2026-09-19: the linux64 build on this hub, the
    // two mac builds on an M-series Mac (the x86_64 one under Rosetta).
    expect(getFfmpegArtifact('linux', 'x64').expectedHwaccels).toEqual(
      expect.arrayContaining(['vaapi', 'qsv']),
    )
    expect(getFfmpegArtifact('darwin', 'arm64').expectedHwaccels).toContain('videotoolbox')
    // arm64 linux has no QSV in this build — claiming it would make the
    // post-download assertion cry wolf on every ARM node.
    expect(getFfmpegArtifact('linux', 'arm64').expectedHwaccels).not.toContain('qsv')
  })

  it('carries a pinned Windows x64 build of the same release, with the D3D hwaccels', () => {
    const win = getFfmpegArtifact('win32', 'x64')
    expect(win.url).toContain(`v${FFMPEG_RELEASE}/`)
    expect(win.url).toContain(`_${FFMPEG_RELEASE}_portable_win64`)
    expect(win.url.endsWith('-gpl.zip')).toBe(true)
    expect(win.archiveFormat).toBe('zip')
    expect(win.sha256).toMatch(/^[0-9a-f]{64}$/)
    // hwaccel-resolver names D3D11VA/DXVA2 for win32: the build must carry them.
    expect(win.expectedHwaccels).toEqual(expect.arrayContaining(['d3d11va', 'dxva2']))
    expect(getFfmpegArtifact('linux', 'x64').url).not.toBe(win.url)
  })

  it('has no Windows ARM build yet and says so', () => {
    expect(() => getFfmpegArtifact('win32', 'arm64')).toThrow(/Unsupported/)
  })

  it('refuses a platform or architecture we have no artifact for', () => {
    expect(() => getFfmpegArtifact('freebsd', 'x64')).toThrow(/Unsupported/)
    expect(() => getFfmpegArtifact('linux', 'mips')).toThrow(/Unsupported/)
  })
})
