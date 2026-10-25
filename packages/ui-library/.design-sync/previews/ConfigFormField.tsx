import type { ReactNode } from 'react'
import { ConfigFormField } from '@camstack/ui-library'

// CamStack is dark-first — render every story on the DS dark canvas.
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

// ConfigFormField is schema-driven: pass a ConfigField descriptor + the current
// values map. We use the scalar field types that render without a host
// provider/context (text, password, number, boolean, select).
const noop = () => {}

export const TextField = () => (
  <Frame>
    <div className="w-80">
      <ConfigFormField
        field={{
          type: 'text',
          key: 'name',
          label: 'Camera name',
          description: 'Shown across grids and event notifications.',
          placeholder: 'e.g. Driveway',
          required: true,
        }}
        values={{ name: 'Front Door' }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const PasswordField = () => (
  <Frame>
    <div className="w-80">
      <ConfigFormField
        field={{
          type: 'password',
          key: 'rtspPassword',
          label: 'RTSP password',
          description: 'Credential used by restreamer to pull the stream.',
          showToggle: true,
        }}
        values={{ rtspPassword: 'hunter2-secret' }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const NumberField = () => (
  <Frame>
    <div className="w-80">
      <ConfigFormField
        field={{
          type: 'number',
          key: 'retentionDays',
          label: 'Clip retention',
          description: 'How long recorded clips are kept on the hub.',
          min: 1,
          max: 90,
          step: 1,
          unit: 'days',
        }}
        values={{ retentionDays: 14 }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const BooleanField = () => (
  <Frame>
    <div className="w-80">
      <ConfigFormField
        field={{
          type: 'boolean',
          key: 'recording',
          label: 'Continuous recording',
          description: 'Persist 24/7 footage to the NVR.',
          style: 'switch',
        }}
        values={{ recording: true }}
        onChange={noop}
      />
    </div>
  </Frame>
)

export const SelectField = () => (
  <Frame>
    <div className="w-80">
      <ConfigFormField
        field={{
          type: 'select',
          key: 'provider',
          label: 'Source provider',
          description: 'Integration this camera connects through.',
          options: [
            { value: 'onvif', label: 'ONVIF NVR' },
            { value: 'hikvision', label: 'Hikvision' },
            { value: 'reolink', label: 'Reolink' },
            { value: 'rtsp', label: 'Generic RTSP' },
          ],
        }}
        values={{ provider: 'onvif' }}
        onChange={noop}
      />
    </div>
  </Frame>
)
