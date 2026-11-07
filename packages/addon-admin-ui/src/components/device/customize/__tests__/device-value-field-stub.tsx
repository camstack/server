import type { DeviceValueFieldProps } from '@camstack/ui-library'

/**
 * A light stand-in for the library's `DeviceValueField` in the dialog specs: the real
 * one needs the system provider for its device grouping. It keeps the contract the
 * dialogs rely on: only the given devices are listed, only the given value rows are
 * drawn, a pick calls back, and the transform and preview regions render once there
 * is a pick.
 */
export function DeviceValueFieldStub(p: DeviceValueFieldProps) {
  const showRegion = p.value !== null || p.alwaysShowPreview === true
  return (
    <div data-testid={p.testId ?? 'device-value-field'}>
      {p.suggestions}
      <div data-testid={p.deviceListTestId} data-value={p.deviceId ?? ''}>
        {p.devices.map((device) => (
          <button key={device.id} type="button" onClick={() => p.onDeviceChange(device.id)}>
            {device.name}
            {device.location !== undefined ? ` · ${device.location}` : ''}
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
