import { describe, expect, it } from 'vitest'
import { findThirdPartyProducts } from '../check-no-third-party-products.js'

const hits = (text: string, file = 'notes.md'): readonly string[] =>
  findThirdPartyProducts(text, file).map((finding) => finding.match)

describe('third-party product guard', () => {
  it('flags a product mention and a comparison', () => {
    expect(hits('import it the way Scrypted does')).toEqual(['Scrypted'])
    expect(hits('a Frigate-style puller')).toEqual(['Frigate'])
    expect(hits('Blue Iris, Shinobi, ZoneMinder, MotionEye')).toHaveLength(4)
    expect(hits('Agent DVR and UniFi Protect')).toHaveLength(2)
    expect(hits('Synology Surveillance, Nabu Casa, Hassio')).toHaveLength(3)
  })

  it('keeps stored ids, upstream artifacts, urls and the restreamer binary', () => {
    expect(hits("provider: 'scrypted'")).toEqual([])
    expect(hits('id: "frigate-plus"')).toEqual([])
    expect(hits('model scrypted-yolov9t-relu-onnx')).toEqual([])
    expect(hits('model frigate-mobiledet-edgetpu')).toEqual([])
    expect(hits('see https://docs.frigate.video/plus and api.frigate.video')).toEqual([])
    expect(hits('repo scrypted/plugin-models')).toEqual([])
    expect(hits("if (/scrypted/i.test(id)) return 'scrypted'")).toEqual([])
    expect(hits("platforms.add('hassio')")).toEqual([])
    expect(hits('family scrypted:yolov9')).toEqual([])
    expect(hits('curl bin/go2rtc from install-go2rtc.sh')).toEqual([])
    expect(hits('the binary name go2rtc is the product', 'scripts/install-go2rtc.sh')).toEqual([])
  })

  it('does not keep a product word that merely sits beside an allowed token', () => {
    expect(
      hits("provider: 'scrypted' // unlike Frigate").map((word) => word.toLowerCase()),
    ).toEqual(['frigate'])
  })
})
