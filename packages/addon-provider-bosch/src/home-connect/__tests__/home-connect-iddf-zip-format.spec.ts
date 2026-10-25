import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { extractZipEntries, parseIddfZipBuffer } from '../home-connect-iddf.js'

const DEVICE_XML =
  '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>'
const MAPPING_XML =
  '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>'

/**
 * A streamed ZIP, as a Java `ZipOutputStream` writes it: general-purpose bit 3 set, CRC and
 * sizes ZERO in every local header, the real values in a data descriptor after the data and in
 * the central directory. A parser that trusts the local header reads zero entries from it.
 */
function buildStreamedZip(files: Readonly<Record<string, string>>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const payload = deflateRawSync(raw)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0008, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(payload.length, 8)
    descriptor.writeUInt32LE(raw.length, 12)
    const entry = Buffer.alloc(46 + nameBuf.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0008, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(payload.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    nameBuf.copy(entry, 46)
    parts.push(local, payload, descriptor)
    central.push(entry)
    offset += local.length + payload.length + descriptor.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

describe('IDDF archive format', () => {
  const zip = buildStreamedZip({
    '014100544323005961_DeviceDescription.xml': DEVICE_XML,
    '014100544323005961_FeatureMapping.xml': MAPPING_XML,
  })

  it('reads a streamed ZIP (data descriptors) from its central directory', () => {
    const entries = extractZipEntries(zip)
    expect([...entries.keys()].toSorted()).toEqual([
      '014100544323005961_DeviceDescription.xml',
      '014100544323005961_FeatureMapping.xml',
    ])
    expect(entries.get('014100544323005961_FeatureMapping.xml')?.toString('utf8')).toBe(MAPPING_XML)
  })

  it('maps the entities of a streamed IDDF archive', () => {
    const compact = parseIddfZipBuffer(zip, '014100544323005961')
    expect(compact).not.toBeNull()
    const index = entityIndexFromDescription(JSON.parse(JSON.stringify(compact)))
    expect(index.get(552)?.name).toBe('BSH.Common.Status.OperationState')
  })

  it('a body that is not a ZIP yields no entries rather than throwing', () => {
    expect(extractZipEntries(Buffer.from('{"error":"nope"}')).size).toBe(0)
    expect(extractZipEntries(Buffer.alloc(0)).size).toBe(0)
  })
})
