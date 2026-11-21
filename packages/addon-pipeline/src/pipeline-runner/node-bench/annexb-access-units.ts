/**
 * Annex B → access units, for the node benchmark's synthetic decode source
 * (D1078). The encoder is told to write an access-unit delimiter before every
 * coded picture, so a unit is "from one delimiter to the next": no slice
 * header is parsed and nothing is guessed. A stream that carries no delimiter
 * yields nothing — the caller refuses the source instead of pacing one giant
 * unit.
 */

export type AnnexBCodec = 'h264' | 'h265'

/** One coded picture with its parameter sets, Annex B, delimiter included. */
export interface AccessUnit {
  readonly data: Buffer
  readonly keyframe: boolean
}

const H264_AUD = 9
const H264_IDR = 5
const H265_AUD = 35
const H265_IRAP_FIRST = 16
const H265_IRAP_LAST = 21

function nalType(data: Buffer, headerAt: number, codec: AnnexBCodec): number | null {
  const header = data[headerAt]
  if (header === undefined) return null
  return codec === 'h264' ? header & 0x1f : (header >> 1) & 0x3f
}

function isDelimiter(type: number, codec: AnnexBCodec): boolean {
  return codec === 'h264' ? type === H264_AUD : type === H265_AUD
}

function isKeyPicture(type: number, codec: AnnexBCodec): boolean {
  return codec === 'h264' ? type === H264_IDR : type >= H265_IRAP_FIRST && type <= H265_IRAP_LAST
}

const START_CODE = Buffer.from([0, 0, 1])

export function splitAccessUnits(data: Buffer, codec: AnnexBCodec): readonly AccessUnit[] {
  const units: AccessUnit[] = []
  let unitStart = -1
  let keyframe = false
  let at = data.indexOf(START_CODE)
  while (at !== -1) {
    const type = nalType(data, at + START_CODE.length, codec)
    if (type !== null && isDelimiter(type, codec)) {
      // A four-byte start code keeps its leading zero with the unit it opens.
      const begin = at > 0 && data[at - 1] === 0 ? at - 1 : at
      if (unitStart !== -1) units.push({ data: data.subarray(unitStart, begin), keyframe })
      unitStart = begin
      keyframe = false
    } else if (type !== null && unitStart !== -1 && isKeyPicture(type, codec)) {
      keyframe = true
    }
    at = data.indexOf(START_CODE, at + START_CODE.length)
  }
  if (unitStart !== -1) units.push({ data: data.subarray(unitStart), keyframe })
  return units
}
