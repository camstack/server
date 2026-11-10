# @camstack/addon-provider-enpal

Enpal solar box provider for CamStack: the box is an integration, and the equipment it reports (photovoltaic, battery, grid, house, heat pump) is adopted as Container devices with history. There is no device for the box itself.

## What it does

- **Enpal** (`provider-enpal`): add an integration with the box's host. The addon reads the box through its own web-page channel (the one its web UI uses; an embedded Python bridge), or its InfluxDB 2.x, or its local device page, and offers one Container per piece of equipment the box actually reports. Adopting a container adopts its children.
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`.

Containers and their children (a container is offered only when the box reported at least one of its values; a child only when the box reported its value):

| Container | Child | Caps |
| --- | --- | --- |
| Photovoltaic | Production | `power-meter` (W, lifetime kWh) |
| | Inverter temperature | `numeric-sensor` |
| Battery | Battery | `battery` (state of charge), `power-meter` (signed W, V, A) |
| | Energy charged / discharged | `meter` (lifetime kWh) |
| | Temperature, Health | `numeric-sensor` |
| Grid | Import, Export | `power-meter` (W, lifetime kWh) |
| House | Consumption | `power-meter` |
| Heat pump | Consumption | `power-meter` |
| | Hot water temperature, Outside temperature | `numeric-sensor` |

Removing the integration removes its devices. An unreachable box marks its devices offline; it never publishes zeros. A lifetime counter that drops for one poll is held at its previous value.

## Integration settings

- **Box host / IP** — the box on the LAN. The box does not advertise itself, so the integration is added by hand.
- **Source** — `auto` (the box web channel, then InfluxDB when a token is set, then the device page; the first that answers wins), `blazor`, `influx`, or `page`.
- **InfluxDB access token** — issued by Enpal support (ask in the Enpal app chat). Stored in the keychain. Organisation (`enpal`), bucket (`solar`) and port (`8086`) default to the usual values.
- **Poll interval** — 30 s by default, 10 s minimum. With the web channel in use (`auto` or `blazor`) the effective interval is never below 20 s, the worst-case read time. In `auto`, a failed web channel is skipped for 10 minutes and the snapshot says why; a node without Python says so too.
- **Invert battery power sign** — flip it when charging shows as negative.

Firmware 8.51 and later render the device rows of the device page only through a Blazor Server web socket. The `blazor` source opens that channel the way the box's own page does (read-only: it only acknowledges renders, it never sends a UI event) and needs no credential. Its protocol modules are copied from the Home Assistant component derolli1976/enpal (MIT, see `THIRD_PARTY.md`). It needs the platform's embedded Python; without it `auto` falls back to InfluxDB or the page, which on those boxes hold less. Only numeric sensors are read; wallbox and heat-pump controls are not part of this addon.

## Requirements

- A CamStack hub on the same network as the box.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-enpal` on npm.

## What it provides

- **Enpal** (`provider-enpal`): Add an Enpal solar box as an integration (its own web-page channel, InfluxDB or the device page) and adopt its equipment: photovoltaic, battery, grid, house and heat pump. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Box: Box host / IP
- Data source: Source, InfluxDB access token, InfluxDB organisation, InfluxDB bucket, InfluxDB port, Device page port
- Polling: Poll interval (ms), Invert battery power sign

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
