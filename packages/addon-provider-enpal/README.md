# @camstack/addon-provider-enpal

Enpal solar box provider for CamStack: the box is an integration, and the equipment it reports (photovoltaic, battery, grid, house, heat pump) is adopted as Container devices with history. There is no device for the box itself.

## What it does

- **Enpal** (`provider-enpal`): add an integration with the box's host. The addon polls the box's InfluxDB 2.x (or, as fallback, its local device page) and offers one Container per piece of equipment the box actually reports. Adopting a container adopts its children.
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
- **Source** — `auto` (InfluxDB when a token is set, the device page otherwise or when InfluxDB cannot be read), `influx`, or `page`.
- **InfluxDB access token** — issued by Enpal support (ask in the Enpal app chat). Stored in the keychain. Organisation (`enpal`), bucket (`solar`) and port (`8086`) default to the usual values.
- **Poll interval** — 30 s by default, 10 s minimum.
- **Invert battery power sign** — flip it when charging shows as negative.

Firmware 8.51 and later render the device rows of the device page only through a web socket; on those boxes the page fallback finds nothing and InfluxDB is required.

## Requirements

- A CamStack hub on the same network as the box.
