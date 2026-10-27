# @camstack/addon-provider-enpal

Enpal solar box device-provider addon for CamStack — PV production, inverter, battery, grid import/export, house consumption and heat pump as Sensor devices with history.

## What it does

- **Enpal** (`provider-enpal`): add a box by its host; the box is a Hub device that polls the box's InfluxDB 2.x (or, as fallback, its local device page) and offers the data groups it actually reports for adoption.
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

Devices (each adopted from the box's discovery panel, only when the box reports them):

| Device | Caps |
| --- | --- |
| PV production | `power-meter` (W, lifetime kWh) |
| Battery | `battery` (state of charge), `power-meter` (signed W, V, A) |
| Battery charged / discharged | `meter` (lifetime kWh) |
| Grid import / export | `power-meter` (W, lifetime kWh) |
| House consumption | `power-meter` |
| Heat pump, hot water, outside temperature | `power-meter` / `numeric-sensor` |
| Inverter / battery temperature, battery health | `numeric-sensor` |

An unreachable box marks its devices offline; it never publishes zeros. A lifetime counter that drops for one poll is held at its previous value.

## Settings

- **Box host / IP** — the box on the LAN. The box does not advertise itself, so it is added by hand.
- **Source** — `auto` (InfluxDB when a token is set, the device page otherwise or when InfluxDB cannot be read), `influx`, or `page`.
- **InfluxDB access token** — issued by Enpal support (ask in the Enpal app chat). Stored in the keychain. Organisation (`enpal`), bucket (`solar`) and port (`8086`) default to the usual values.
- **Poll interval** — 30 s by default, 10 s minimum.
- **Invert battery power sign** — flip it when charging shows as negative.

Firmware 8.51 and later render the device rows of the device page only through a web socket; on those boxes the page fallback finds nothing and InfluxDB is required.

## Requirements

- A CamStack hub on the same network as the box.
