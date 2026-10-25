import { describe, expect, it } from 'vitest'
import {
  entityIndexFromDescription,
  parseHomeConnectIddfXml,
} from '../home-connect-device-description.js'
import { buildStoreZip, parseIddfZipBuffer } from '../home-connect-iddf.js'

describe('entityIndexFromDescription', () => {
  it('returns empty index for null', () => {
    expect(entityIndexFromDescription(null).size).toBe(0)
  })
})

describe('parseHomeConnectIddfXml', () => {
  it('maps uid 552 (0x228) to OperationState with enumeration', () => {
    const deviceWithEnum = `<?xml version="1.0"?><device><description><type>Dishwasher</type><model>M</model></description>
      <statusList uid="0001"><status uid="228" enumerationType="3002" refCID="03" refDID="00"/></statusList>
      <enumerationTypeList><enumerationType enid="3002"><enumeration value="1"/></enumerationType></enumerationTypeList>
      </device>`
    const mappingWithEnum = `<?xml version="1.0"?><featureMappingFile>
      <featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription>
      <errorDescription/>
      <enumDescriptionList><enumDescription refENID="3002" enumKey="OperationState">
        <enumMember refValue="1">Ready</enumMember>
      </enumDescription></enumDescriptionList>
      </featureMappingFile>`
    const compact = parseHomeConnectIddfXml({
      deviceDescriptionXml: deviceWithEnum,
      featureMappingXml: mappingWithEnum,
      haId: 'HAI-DW-1',
    })
    const index = entityIndexFromDescription(JSON.parse(JSON.stringify(compact)))
    expect(index.get(552)?.name).toBe('BSH.Common.Status.OperationState')
    expect(index.get(552)?.enumeration?.[1]).toBe('Ready')
  })

  it('parses a store-only IDDF zip buffer', () => {
    const zip = buildStoreZip({
      'appliance_DeviceDescription.xml':
        '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>',
      'appliance_FeatureMapping.xml':
        '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>',
    })
    const parsed = parseIddfZipBuffer(zip, 'HAI-1')
    expect(parsed?.info.deviceID).toBe('HAI-1')
    expect(
      entityIndexFromDescription(JSON.parse(JSON.stringify(parsed ?? {}))).get(552)?.name,
    ).toBe('BSH.Common.Status.OperationState')
  })
})
