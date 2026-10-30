import type { ConfigUISchema } from '@camstack/types'

/**
 * Creation form for Reolink devices.
 *
 * Designed to be **type-agnostic** at input time — the operator never
 * picks NVR / battery / regular themselves. Instead they provide
 * connection parameters (transport, host, port, credentials, optional
 * UID) and click `Test`. The provider runs `autoDetectDeviceType` from
 * the nodelink library, returns the detected device class as labels,
 * and on save the `onCreateDevice` handler routes to the right device
 * factory (single TCP camera, UDP/battery camera with UID, NVR with N
 * channels, …).
 *
 * No `channel` field is exposed — channel selection is internal:
 *   - regular cameras use channel 0
 *   - NVR devices expose every channel via `ch{N}-main` / `ch{N}-sub`
 *     stream IDs (Slice 8); no operator choice is required
 */
/**
 * Extra per-scan inputs for Reolink network discovery. Unlike Gree/Ecowitt, a Reolink camera needs
 * CREDENTIALS to be created — so the scan form collects them: the library uses them to enrich the
 * probe (model/UID via the authenticated API) and they are baked into each candidate so a one-click
 * adopt yields a working camera. The subnets scanned are the engine's (`params.subnets`); ONVIF WS-Discovery is on by default since most Reolink cameras support it.
 */
export function buildDiscoveryParamsFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-reolink:discoveryParams.s_credentials.title',
        description: 'Assumes all cameras share these credentials.',
        descriptionKey: 'provider-reolink:discoveryParams.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-reolink:discoveryParams.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-reolink:discoveryParams.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'scan',
        title: 'Scan options',
        titleKey: 'provider-reolink:discoveryParams.s_scan.title',
        description: 'The networks scanned are set on the Network page.',
        descriptionKey: 'provider-reolink:discoveryParams.s_scan.description',
        columns: 1,
        fields: [
          {
            type: 'boolean',
            key: 'enableOnvif',
            label: 'Include ONVIF discovery',
            labelKey: 'provider-reolink:discoveryParams.s_scan.enableOnvif.label',
            default: true,
          },
          {
            type: 'number',
            key: 'timeoutMs',
            label: 'Scan timeout (ms)',
            labelKey: 'provider-reolink:discoveryParams.s_scan.timeoutMs.label',
            min: 1_000,
            max: 30_000,
            default: 5_000,
          },
        ],
      },
    ],
  }
}

export function buildCreationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Camera',
        titleKey: 'provider-reolink:creation.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-reolink:creation.s_identity.name.label',
            required: true,
            placeholder: 'Front Door',
          },
        ],
      },
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-reolink:creation.s_credentials.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-reolink:creation.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-reolink:creation.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-reolink:creation.s_connection.title',
        columns: 2,
        fields: [
          {
            type: 'select',
            key: 'transport',
            label: 'Connection mode',
            labelKey: 'provider-reolink:creation.s_connection.transport.label',
            default: 'auto',
            description: 'Auto tries TCP, then UDP. Battery cameras behind NAT need UDP.',
            descriptionKey: 'provider-reolink:creation.s_connection.transport.description',
            options: [
              {
                value: 'auto',
                label: 'Auto (recommended)',
                labelKey: 'provider-reolink:creation.s_connection.transport.o_auto.label',
              },
              {
                value: 'tcp',
                label: 'TCP only',
                labelKey: 'provider-reolink:creation.s_connection.transport.o_tcp.label',
              },
              {
                value: 'udp',
                label: 'UDP only (battery / cloud)',
                labelKey: 'provider-reolink:creation.s_connection.transport.o_udp.label',
              },
            ],
          },
          {
            type: 'probe',
            key: 'host',
            label: 'Host (IP / hostname / UID)',
            labelKey: 'provider-reolink:creation.s_connection.host.label',
            required: true,
            placeholder: '192.168.10.100',
            description: 'In UDP-only mode leave blank and use the UID below.',
            descriptionKey: 'provider-reolink:creation.s_connection.host.description',
            inputType: 'text',
          },
          {
            type: 'number',
            key: 'port',
            label: 'Port',
            labelKey: 'provider-reolink:creation.s_connection.port.label',
            default: 9000,
            min: 1,
            max: 65535,
            step: 1,
            showWhen: { field: 'transport', notEquals: 'udp' },
          },
          {
            type: 'text',
            key: 'uid',
            label: 'Device UID',
            labelKey: 'provider-reolink:creation.s_connection.uid.label',
            placeholder: '9527000XXXXXXXX',
            description: 'Needed for battery / UDP cameras that are not on the same LAN.',
            descriptionKey: 'provider-reolink:creation.s_connection.uid.description',
            showWhen: { field: 'transport', notEquals: 'tcp' },
          },
        ],
      },
    ],
  }
}
