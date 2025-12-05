# Smart-Boiler

## Overview
**Smart-Boiler** is a core component of the intelligent heating control suite, designed to work in tandem with **Smart-Scheduler** and **Smart-Valve**.

*   **Smart-Scheduler**: Manages heating schedules and target temperatures.
*   **Smart-Valve**: Groups and controls individual radiator valves (TRVs) by room/zone.
*   **Smart-Boiler**: Acts as the central controller. It aggregates demand from all connected Smart-Valve nodes and determines the optimal boiler operation (On/Off, Setpoint) based on the highest heating requirement.

This node is designed to integrate with Home Assistant via MQTT and can optionally control an OpenTherm gateway.

## Features
*   **Demand Aggregation**: Collects temperature and setpoint data from multiple valves.
*   **Intelligent Firing**: Calculates the "Active Valve" based on the largest gap between setpoint and current temperature.
*   **Safety Watchdog**: Automatically reverts to safe defaults if no updates are received from valves within a configurable timeframe.
*   **MQTT Integration**: Publishes boiler status, setpoint, and the name of the "Leading Device" (the valve driving the boiler) to MQTT.
*   **Message Storm Protection**: Prevents processing overload by limiting the rate of incoming messages.

## Input Message Format

The node expects a `msg.payload` object containing a command and valve data. This is typically generated automatically by **Smart-Valve** nodes.

### Update Command (`set`)
Used to update the status of a valve in the boiler's internal stack.

```javascript
msg.payload = {
    command: "set",         // Required
    setpoint: 21.5,         // Target temperature in °C (number)
    temperature: 19.0,      // Current temperature in °C (number)
    requestedBy: "Kitchen", // Unique name/ID of the valve (string)
    groupId: 1              // Group ID the valve belongs to (number)
}
```

### Other Commands
*   `command: "trigger"`: Forces the boiler to re-evaluate its state and publish updates immediately.
*   `command: "stack"`: Outputs the current internal stack of known valves to the debug output.

## Logic & Operation

### 1. Valve Stack Management
Every time a `set` command is received, the node updates its internal "Live Stack". If the valve (`requestedBy`) is new, it is added; otherwise, its values are updated.

### 2. Active Valve Selection
On every cycle (or update), the node evaluates all valves in the stack to determine if the boiler should run.

*   **Active Condition**: A valve is considered "Active" if `setpoint > temperature`.
*   **Priority Rule**: The boiler follows the valve with the **highest gap** (`setpoint - temperature`).
    *   *Example*:
        *   Valve A: SP 20°C, Temp 21°C (Inactive)
        *   Valve B: SP 22°C, Temp 21°C (Gap +1)
        *   Valve C: SP 24°C, Temp 20°C (Gap +4) -> **Winner**
    *   **Tie-Breaker**: If gaps are equal, the valve with the higher setpoint wins.

### 3. Boiler Control
*   **Heating On**: If an Active Valve is found, the boiler is switched ON (via MQTT topic). The boiler setpoint is set to the Active Valve's setpoint.
*   **Heating Off**: If no valves are active (all rooms are warm enough), the boiler is switched OFF.

### 4. Safety Watchdog
If no valid input is received for a duration exceeding **Max duration since last input** (configurable):
*   The boiler enters **Security Mode**.
*   It publishes the **Default Temp** and **Default Setpoint** to the boiler.
*   This prevents the boiler from getting stuck in a "Heating" state if the control network fails.

## Configuration

| Parameter | Description |
| :--- | :--- |
| **Name** | Node name (also used as the Home Assistant device name). |
| **Boiler Entity** | The ID of the boiler device in Home Assistant (used to auto-generate MQTT topics). |
| **MQTT Settings** | Reference to the MQTT Broker configuration node. |
| **MQTT Updates** | If checked, the node will publish updates to the configured MQTT topics. |
| **Output Updates** | If checked, the node will send a message to its output port on change. |
| **Update Cycle** | How often (in seconds) the node re-evaluates the valve stack. |
| **Trigger Mode** | When to trigger outputs: `State Change`, `State Change + Startup`, or `Every Cycle`. |
| **Max Duration** | Time (in minutes) without input before triggering Security Mode. |
| **Default Temp/SP** | Fallback values used in Security Mode. |
| **Boiler Security** | Enable/Disable the watchdog security feature. |

## Outputs

### MQTT Topics
The node publishes to the following topics (prefixed by the configured root path, e.g., `homeassistant/boiler_entity_id/...`):
*   `.../setpointTemperature/set`: Target boiler water temperature (or room setpoint, depending on boiler mode).
*   `.../currentTemperature/state`: Current reference temperature (from the leading valve).
*   `.../leadingDevice/state`: Name of the valve currently controlling the boiler.
*   `.../swCentralHeating/set`: `1` (On) or `0` (Off).

### Node Output
If **Output Updates** is enabled, the node sends:
```javascript
msg.payload = {
    sp: 24,
    temp: 20,
    name: "Living Room", // Name of the active valve
    id: "Living Room",
    lastupdate: "2023-10-27T10:00:00.000Z",
    groupId: 1
}
```

## Installation
1.  Install via Node-RED Palette Manager or `npm install`.
2.  Ensure you have an MQTT broker running.
3.  Configure the **Smart-Valve** nodes to send data to this **Smart-Boiler** node (usually via a Link node or direct wire).

## License
Creative Commons
