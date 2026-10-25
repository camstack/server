import type { ConfigUISchema } from '@camstack/types'

/**
 * Manual creation form for a Wyze camera.
 *
 * The PRIMARY onboarding path is discovery — the provider's
 * `discoverDevices()` enumerates the Wyze cloud's camera list and the
 * operator adopts a candidate (every P2P parameter auto-populated from
 * the cloud blob). This manual form is the fallback for adding a camera
 * by its P2P parameters directly. The parameters come from the Wyze cloud
 * (`mac`, `p2pId`/uid, `enr`, local `ip`, `productModel`), not a LAN scan.
 */
export function buildCreationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Camera',
        titleKey: 'provider-wyze:creation.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-wyze:creation.s_identity.name.label',
            required: true,
            placeholder: 'Front Door',
          },
        ],
      },
      {
        id: 'p2p',
        title: 'P2P parameters',
        titleKey: 'provider-wyze:creation.s_p2p.title',
        description:
          'Values from the Wyze cloud device list; discovery fills them in automatically.',
        descriptionKey: 'provider-wyze:creation.s_p2p.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'mac',
            label: 'MAC',
            labelKey: 'provider-wyze:creation.s_p2p.mac.label',
            required: true,
            placeholder: '80482C53405B',
          },
          {
            type: 'text',
            key: 'p2pId',
            label: 'P2P UID',
            labelKey: 'provider-wyze:creation.s_p2p.p2pId.label',
            required: true,
            placeholder: 'WYZE camera UID',
          },
          {
            type: 'text',
            key: 'enr',
            label: 'ENR (encryption key)',
            labelKey: 'provider-wyze:creation.s_p2p.enr.label',
            required: true,
          },
          {
            type: 'text',
            key: 'ip',
            label: 'Local IP',
            labelKey: 'provider-wyze:creation.s_p2p.ip.label',
            required: true,
            placeholder: '192.168.10.41',
          },
          {
            type: 'text',
            key: 'productModel',
            label: 'Product model',
            labelKey: 'provider-wyze:creation.s_p2p.productModel.label',
            required: true,
            placeholder: 'WYZE_CAKP2JFUS',
          },
        ],
      },
      {
        id: 'stream',
        title: 'Stream',
        titleKey: 'provider-wyze:creation.s_stream.title',
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'resolution',
            label: 'Resolution',
            labelKey: 'provider-wyze:creation.s_stream.resolution.label',
            default: 'fhd',
            options: [
              {
                value: 'fhd',
                label: '1080p (FHD)',
                labelKey: 'provider-wyze:creation.s_stream.resolution.o_fhd.label',
              },
              {
                value: 'hd',
                label: '720p (HD)',
                labelKey: 'provider-wyze:creation.s_stream.resolution.o_hd.label',
              },
              {
                value: 'qhd',
                label: '2K (QHD)',
                labelKey: 'provider-wyze:creation.s_stream.resolution.o_qhd.label',
              },
              {
                value: 'low',
                label: '360p (SD)',
                labelKey: 'provider-wyze:creation.s_stream.resolution.o_low.label',
              },
            ],
          },
          {
            type: 'select',
            key: 'bitrate',
            label: 'Bitrate',
            labelKey: 'provider-wyze:creation.s_stream.bitrate.label',
            default: 'max',
            options: [
              {
                value: 'max',
                label: 'Max',
                labelKey: 'provider-wyze:creation.s_stream.bitrate.o_max.label',
              },
              {
                value: 'sd',
                label: 'SD',
                labelKey: 'provider-wyze:creation.s_stream.bitrate.o_sd.label',
              },
            ],
          },
          {
            type: 'select',
            key: 'motionSource',
            label: 'Motion source',
            labelKey: 'provider-wyze:creation.s_stream.motionSource.label',
            default: 'cloud',
            description:
              'Cloud: poll the Wyze events API (works while the camera sleeps). Boa: on-camera SD-card poller (needs an active stream + SD card).',
            descriptionKey: 'provider-wyze:creation.s_stream.motionSource.description',
            options: [
              {
                value: 'cloud',
                label: 'Cloud events',
                labelKey: 'provider-wyze:creation.s_stream.motionSource.o_cloud.label',
              },
              {
                value: 'boa',
                label: 'On-camera (boa)',
                labelKey: 'provider-wyze:creation.s_stream.motionSource.o_boa.label',
              },
            ],
          },
        ],
      },
    ],
  }
}
