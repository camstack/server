import { describe, it, expect } from 'vitest'
import { cloudflaredAsset } from '../ensure-cloudflared'

describe('cloudflaredAsset', () => {
  it('maps linux arches to bare binaries', () => {
    expect(cloudflaredAsset('linux', 'x64')).toEqual({
      fileName: 'cloudflared-linux-amd64',
      isArchive: false,
    })
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({
      fileName: 'cloudflared-linux-arm64',
      isArchive: false,
    })
    expect(cloudflaredAsset('linux', 'arm')).toEqual({
      fileName: 'cloudflared-linux-arm',
      isArchive: false,
    })
  })

  it('maps darwin to a .tgz archive (arm64 falls back to amd64 via Rosetta)', () => {
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({
      fileName: 'cloudflared-darwin-amd64.tgz',
      isArchive: true,
    })
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({
      fileName: 'cloudflared-darwin-amd64.tgz',
      isArchive: true,
    })
  })

  it('maps win32 to a .exe', () => {
    expect(cloudflaredAsset('win32', 'x64')).toEqual({
      fileName: 'cloudflared-windows-amd64.exe',
      isArchive: false,
    })
  })

  it('throws on an unsupported arch or platform', () => {
    expect(() => cloudflaredAsset('linux', 'mips')).toThrow(/unsupported arch/)
    expect(() => cloudflaredAsset('freebsd' as NodeJS.Platform, 'x64')).toThrow(
      /unsupported platform/,
    )
  })
})
