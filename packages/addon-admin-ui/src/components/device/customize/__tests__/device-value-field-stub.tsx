import type { DeviceValueFieldProps } from '@camstack/ui-library'
import type { ReactElement } from 'react'

/** One device the stub lists: the fields a row shows and the filters read. */
export interface StubDevice {
  readonly id: number
  readonly name: string
  readonly type?: string
  readonly location?: string | null
  /** The caps the device carries; when given, `requires` narrows the list as the search would. */
  readonly caps?: readonly string[]
}

function meetsRequires(device: StubDevice, requires: DeviceValueFieldProps['requires']): boolean {
  if (requires === undefined || device.caps === undefined) return true
  const has = (cap: string) => device.caps?.includes(cap) === true
  return requires.mode === 'all' ? requires.caps.every(has) : requires.caps.some(has)
}

/**
 * A light stand-in for the library's `DeviceValueField` in the dialog specs: the real
 * one searches the hub (`deviceManager.search`). It lists `fleet` minus the host and
 * the excluded devices, and shows what the search was asked to require on
 * `data-requires`. Only the given value rows are drawn, a pick calls back, and the
 * transform and preview regions render once there is a pick.
 *
 * It imports nothing at runtime from `@camstack/ui-library`: the specs build it
 * inside their own mock factory of that package, and a value import would wait on
 * the factory that is waiting on it.
 */
export function deviceValueFieldStub(
  fleet: readonly StubDevice[],
): (p: DeviceValueFieldProps) => ReactElement {
  return function DeviceValueFieldStub(p: DeviceValueFieldProps): ReactElement {
    return <StubBody fleet={fleet} {...p} />
  }
}

interface StubBodyProps extends DeviceValueFieldProps {
  readonly fleet: readonly StubDevice[]
}

function StubBody({ fleet, ...p }: StubBodyProps): ReactElement {
  const showRegion = p.value !== null || p.alwaysShowPreview === true
  const hidden = new Set([...(p.excludeIds ?? []), p.contextDeviceId])
  const devices = fleet.filter(
    (d) =>
      !hidden.has(d.id) &&
      !(p.excludeTypes ?? []).includes(String(d.type)) &&
      meetsRequires(d, p.requires),
  )
  return (
    <div data-testid={p.testId ?? 'device-value-field'}>
      {p.suggestions}
      <div
        data-testid={p.deviceListTestId}
        data-value={p.deviceId ?? ''}
        data-requires={p.requires?.caps?.join(',') ?? ''}
      >
        {devices.map((device) => (
          <button key={device.id} type="button" onClick={() => p.onDeviceChange(device.id)}>
            {device.name}
            {device.location !== undefined && device.location !== null
              ? ` · ${device.location}`
              : ''}
          </button>
        ))}
      </div>
      {p.deviceId !== null ? (
        <div>
          {p.valuesBefore}
          {p.valuesOverride ??
            p.groups.flatMap((group) =>
              group.rows.map((row) => (
                <input
                  key={`${row.cap}.${row.path}`}
                  type="radio"
                  readOnly
                  aria-label={row.label}
                  data-testid={p.rowTestId?.(row)}
                  checked={p.value?.cap === row.cap && p.value.path === row.path}
                  onChange={() => p.onValueChange({ cap: row.cap, path: row.path })}
                  onClick={() => p.onValueChange({ cap: row.cap, path: row.path })}
                />
              )),
            )}
        </div>
      ) : null}
      {showRegion ? (
        <div>
          {p.transform}
          {p.proposal}
          {p.preview}
        </div>
      ) : null}
    </div>
  )
}
