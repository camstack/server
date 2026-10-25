import { describe, expect, it } from 'vitest'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { buildDeflateZip, buildStoreZip, parseIddfZipBuffer } from '../home-connect-iddf.js'

const deviceXml =
  '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>'
const mappingXml =
  '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>'

const iddfFiles = {
  'appliance_DeviceDescription.xml': deviceXml,
  'appliance_FeatureMapping.xml': mappingXml,
}

describe('parseIddfZipBuffer', () => {
  it('parses store-only zip', () => {
    const zip = buildStoreZip(iddfFiles)
    const parsed = parseIddfZipBuffer(zip, 'HAI-1')
    expect(
      parsed
        ? entityIndexFromDescription(JSON.parse(JSON.stringify(parsed))).get(552)?.name
        : undefined,
    ).toBe('BSH.Common.Status.OperationState')
  })

  it('parses deflate (method 8) zip like cloud IDDF', () => {
    const zip = buildDeflateZip(iddfFiles)
    const parsed = parseIddfZipBuffer(zip, 'HAI-1')
    expect(
      parsed
        ? entityIndexFromDescription(JSON.parse(JSON.stringify(parsed))).get(552)?.name
        : undefined,
    ).toBe('BSH.Common.Status.OperationState')
  })
})
