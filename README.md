# Smart-Boiler Node

The `smart-boiler` node decides whether the house needs heat and tells the boiler controller (for example an ESPHome OpenTherm gateway) which setpoint and room temperature to regulate on, over MQTT. It receives one message per room from the `smart-valve` nodes, follows the room with the largest gap, ignores rooms that went silent or cannot be satisfied, and can publish its state to Home Assistant.

`smart-boiler` decides whether the house needs heat and tells the boiler controller which setpoint and
room temperature to regulate on. It receives one message per room from the `smart-valve` nodes.

```
smart-valve (room 1) ─┐
smart-valve (room 2) ─┼──set──▶ smart-boiler ──MQTT──▶ boiler controller (e.g. ESPHome OpenTherm)
smart-valve (room n) ─┘                          setpoint, room temperature, leading room, central heating on/off
```

## How the decision is made

1. Every room sends its setpoint and temperature (`smart-valve` re-sends at least every 10 min).
2. Rooms that have not reported for **Valve timeout** minutes are ignored; rooms on **hold** are ignored.
3. Among the remaining rooms, the one with the **largest gap** (setpoint − temperature) leads. On a tie, the
   higher setpoint wins.
4. If that gap is positive, **central heating is switched on** and the boiler receives the leading room's
   setpoint and temperature. Otherwise central heating is switched off.
5. If the same room leads for **Unsatisfied** minutes while clearly below its setpoint (more than 0.5 °C) and
   without warming up by **Min rise**, the whole room (all valves of its group) is put on hold for **Hold for**
   minutes and the next room takes over. A room just below its setpoint is never held, and the timer starts again
   after a restart, a silence, a setpoint change or a change of leading room. A room the boiler cannot heat (stuck
   valve, open window, wrong sensor) can no longer keep the boiler running all night.
6. If nothing reports at all for **Max duration**, or every room is silent, the boiler goes to **Security**:
   default setpoint and temperature, central heating off.

A room whose `smart-valve` is FAILED sends its Off setpoint (5 °C), so it never leads.

## Node status

| Status | Meaning |
|---|---|
| 🔴 dot `Active:SV_PARENT, t:20.18°C, sp:21.00°C` | Heating for SV_PARENT |
| 🟢 dot `Active:SV_LOU, t:20.60°C, sp:20.00°C` | No room needs heat; the room closest to needing it is shown |
| 🟡 ring `No update, …` / `All valves silent, …` | Security mode |
| 🟡 ring `All requesting rooms on hold, …` | The only rooms asking for heat are on hold |
| 🟡 dot `Waiting for data...` | Nothing received yet |

## Editor parameters

### General

| Field | What it does | Example |
|---|---|---|
| **Name** | Name of the node, also the Home Assistant device name. | `RSL_BOILER` |
| **Entity ID** | Identifier of the boiler controller. When you type it, empty topic fields are filled in with `<root path>/<entity id>/…`. | `OT_BOILER_64` |
| **MQTT** | MQTT connection (`smart-boiler-settings` node). | `jarvis` |
| **Mqtt updates** | Send the commands to the boiler controller over MQTT (the normal mode). | on |
| **Output updates** | Also send the leading room on the node output (for a debug node or another flow). | on |

### Boiler topics

Each topic has a **Key**: when filled, the value is sent as `{"<key>": value}`; when empty, as a plain number.

| Field | What it sends | Example |
|---|---|---|
| **Current temperature → Set / Key** | Temperature of the leading room (what the boiler regulates on). | `homeassistant/OT_BOILER_64/currentTemperature/state`, key `value` |
| **Set point → Set / Key** | Setpoint of the leading room. | `homeassistant/OT_BOILER_64/setpointTemperature/set` |
| **Leading device → Set name / Set Id / Key** | Name and group id of the leading room, for display in Home Assistant. | `…/leadingDevice/state`, `…/leadingDeviceId/state`, key `value` |
| **Central heating → Set / Key** | `1` when a room needs heat, `0` otherwise. | `homeassistant/OT_BOILER_64/swCentralHeating/set` |

### Timing

| Field | What it does | Default / your setup |
|---|---|---|
| **Cycle** (seconds) | How often the decision is re-evaluated on its own. | `60` s |
| **Trigger mode** | When commands are sent: *when state changes*, *when state changes + startup*, or *every cycle* (re-sent every cycle, recommended so the controller always has fresh values). | every cycle |
| **Max duration** | If no room at all has reported for this long, go to Security mode. | `15` min |

### Safety (new in 0.82)

| Field | What it does | Default | Notes |
|---|---|---|---|
| **Valve timeout** | A room that has not reported for this long is ignored. After 24 h without news it is removed from the saved list, so disabled or deleted valves stop lingering (in 0.81 they stayed forever, across restarts). `0` = never ignore. Valves still on 0.81 (no heartbeat, recognised automatically) are never ignored. | `30` min | smart-valve 0.82 re-sends every 10 min. |
| **Max SP** | Any setpoint above this is capped. | `25` °C | |
| **Unsatisfied … min without rising by … °C** | A room leading this long, more than 0.5 °C below its setpoint, without its temperature rising by this much, is put on hold (all its valves). The window restarts every time the room warms up by Min rise, so a slowly heating room is never held. `0` = off. | `180` min, `0.3` °C | The 29–30 Oct case: Chloe's room led for 11 h at 19 °C. |
| **Hold for** | How long a held room is left out of the decision. It then comes back automatically. | `120` min | |
| **Security** | Enables Security mode (recommended). In 0.82 Security also switches central heating **off**; in 0.81 it only lowered the setpoint and left central heating on. | on | |
| **Default temp / Default set point** | Values sent in Security mode. Keep the setpoint below the temperature so the controller sees no demand. | `10` °C / `7` °C | |

### Debug

| Field | What it does |
|---|---|
| **Debug Level** | None, Error, Warn, Info, Debug. *Warn* shows holds, purges and silent valves. |

## Messages

### Input (from smart-valve)

```json
{ "command": "set", "setpoint": "21.00", "temperature": "20.18", "requestedBy": "SV_PARENT",
  "groupId": "1", "health": "OK", "reasons": [] }
```

Other commands: `trigger` (re-send now), `stack` (output the list of rooms).

### Output

The leading room (when *Output updates* is on): `{ id, name, sp, temp, groupId, lastupdate, health }`,
or `{ name: "Security mode", setpoint, temperature }`.

## Home Assistant

Tick **HA discovery** in the `smart-boiler-settings` node. The boiler appears as a device
**SmartBoiler <name>**:

| Entity | Value |
|---|---|
| Status | `heat`, `idle`, `security`, `no_data` |
| Heat demand (binary sensor) | on when central heating is requested |
| Leading room | name of the room the boiler follows |
| Rooms requesting heat | count; the attribute `requesting` lists them |
| Rooms ignored | count; the attribute `ignored` lists them with the reason (`silent`, `on_hold`, `failed`) |
| Status detail | plain language: who the boiler heats for and why, which rooms are ignored and why, e.g. *"Heating for SV_PARENT: 21.0 °C requested, room 19.8 °C (gap 1.2 °C). Also asking: SV_LOU (0.4 °C). Ignored: SV_CHLOE (valve FAILED: no_ack)."* |
| Problem (binary sensor) | on when a room is ignored or in Security mode |

The attribute `rooms` lists every room with setpoint, temperature, gap, state, health, reasons and last
update. It answers "why is the boiler heating?" at a glance.

## Settings node (`smart-boiler-settings`)

Same fields as the valve settings node: Host, Port, Username, Password, Root path (discovery prefix),
**HA discovery**, **State topic** (`smartheating`), Test Connection.

## Upgrading from 0.81

- Valves still on 0.81 are recognised and never expired, so the boiler can be upgraded first. With every valve
  silent, central heating is switched off even when Security is off.
- Existing nodes keep their configuration; the new fields show their defaults the first time you open them.
- The saved list of rooms is kept; rooms that no longer report drop out after 30 min and are removed after 24 h.

## Tests

```
npm install
npm test
```

19 tests run the node with a fake clock and an in-memory MQTT broker.

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## Installation
1.  Install via Node-RED Palette Manager or `npm install`.
2.  Ensure you have an MQTT broker running.
3.  Configure the **Smart-Valve** nodes to send data to this **Smart-Boiler** node (usually via a Link node or direct wire).

## License
Creative Commons
