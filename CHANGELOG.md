# Changelog

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
