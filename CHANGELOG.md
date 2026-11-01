# Changelog

## 0.83.0 — 2026-11-01

- New `remove` command: drop a valve (`requestedBy`, a name or a list), a room group (`groupId`) or every valve
  (`all: true`) from the stack; the leader, holds and timers are updated and the stack saved.
- Rooms in smart-valve away mode (`away: true`) are listed in Home Assistant (*Rooms away* entity, `away` attribute,
  Status detail) and drive the boiler only below their frost setpoint.

## 0.82.1 — 2026-10-30

- Unsatisfied hold only counts while the room is more than 0.5 °C below its setpoint; a room just below its
  setpoint at full radiator output is no longer cut off.
- Holds apply to the whole room group (several valves on one sensor), and the hold timer starts again after a
  restart, a silence, a setpoint change or a change of leading room (timers are no longer saved to disk).
- Valves still on 0.81 (no heartbeat) are never expired, so the boiler can be upgraded before the valves.
- With every valve silent and Security off, central heating is now switched off.
- New "Status detail" entity: who the boiler heats for, which rooms are ignored and why.

## 0.82.0 — 2026-10-30

- Per-valve expiry ("Valve timeout", default 30 min): a silent valve no longer drives the boiler; valves
  silent for 24 h are removed from the saved stack (disabled or deleted valves used to stay forever).
- Unsatisfied room hold: a room leading 3 h without warming up by 0.3 °C is put on hold for 2 h.
- Security mode now switches central heating off and honours the configured payload keys.
- Max SP (default 25 °C).
- Optional Home Assistant discovery (Status, Heat demand, Leading room, Rooms requesting heat, Rooms ignored,
  Problem) with every room's state as attributes.
- Fixes: MQTT queue dropped after an invalid entry; messages queued before connection sent with a different
  format; possible crash when no room was active; MQTT outage logged once; help of the settings node.
- Editor: new fields, valid on nodes saved by 0.81 (no deploy warning).
- Tests: `npm test` (19 tests).
