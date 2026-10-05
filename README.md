# Waterworks — Shelly 2PM Gen4 Waterworks Controller

**Domestic water supply control system based on Shelly 2PM Gen4**

Waterworks is a control and protection system for a domestic water supply system supplied from a private well.

The system uses a **Shelly 2PM Gen4** to control the well pump, monitor the pressure switch and water level, and expose the system state through MQTT and Home Assistant MQTT Discovery.

The software consists of two independent Shelly scripts:

* **Main script** — normal waterworks control, MQTT communication and Home Assistant integration.
* **Watch Dog** — independent safety layer for pump protection and critical faults.

The two scripts deliberately have different responsibilities. The Watch Dog is not intended to replace the normal control logic.

---

## Hardware

| Shelly channel | Function                       |
| -------------- | ------------------------------ |
| `relay:0`      | Well pump                      |
| `input:0`      | Expansion-tank pressure switch |
| `input:100`    | Analog water level sensor      |

### Pressure switch

The pressure switch is connected to `input:0`.

* Switch closed → pressure demand → pump may run
* Switch open → pressure restored → pump stops

### Water level

`input:100` provides the water level as a percentage.

---

# Control logic

The pump is allowed to start only when all required conditions are satisfied.

```text
Waterworks enabled
        AND
No system alarm
        AND
Water status is not CRITICAL
        AND
(NORMAL status OR Warning Override)
        AND
Pressure demand
```

A running pump cycle is **not normally interrupted** just because the water status, Enabled state or Warning Override changes.

These conditions determine whether a **new pump cycle may start**.

The Watch Dog is the exception: it can physically stop the pump when a safety limit is exceeded.

---

## Water level states

The water level has three states:

| State      |             Level | Meaning                      |
| ---------- | ----------------: | ---------------------------- |
| `NORMAL`   |            > 30 % | Normal operation             |
| `WARNING`  | > 15 % and ≤ 30 % | Pump start requires override |
| `CRITICAL` |            ≤ 15 % | Pump start is blocked        |

A hysteresis of **2 percentage points** is used when recovering to a less severe state.

Therefore:

* `CRITICAL → WARNING` requires level > 17 %
* `WARNING → NORMAL` requires level > 32 %

Hysteresis is only used for recovery. Entering a more severe state happens immediately at the configured limits.

---

## Warning Override

`Warning Override` is available through MQTT / Home Assistant.

It allows a new pump cycle while the water level is in `WARNING`.

It does **not** change the reported water status.

### Rules

* `NORMAL` → pump can run normally
* `WARNING` + Override OFF → new pump cycle blocked
* `WARNING` + Override ON → new pump cycle allowed
* `CRITICAL` → pump start always blocked
* Override is automatically switched OFF when entering `CRITICAL`
* Override is switched OFF when the water level returns to `NORMAL`
* Disabling the waterworks also disables the override

`CRITICAL` can therefore never be bypassed.

---

# Main script

The main script is responsible for:

* reading the pressure switch
* reading the water level
* evaluating the water status
* deciding whether a new pump cycle is allowed
* controlling relay 0
* monitoring pump relay transitions
* detecting repeated short pump cycles
* maintaining the system alarm state
* MQTT communication
* Home Assistant MQTT Discovery
* publishing system status and telemetry

The main script does not act as the safety watchdog.

---

## Short-cycle protection

The main script measures the actual pump relay ON/OFF transitions.

A pump run shorter than:

```text
5 seconds
```

is considered a short cycle.

Five consecutive short cycles cause a system alarm:

```text
Low expansion tank pressure
```

A normal pump cycle resets the short-cycle counter.

This is intended to detect repeated rapid cycling caused, for example, by insufficient expansion-tank pressure.

---

# Watch Dog

The Watch Dog is an independent protection layer.

It is intentionally simpler than the main controller.

Its responsibilities are:

* switch the pump OFF during startup
* monitor pump runtime
* monitor the water level while the pump is running
* stop the pump if the water level reaches the minimum limit
* stop the pump if the maximum pump runtime is exceeded
* raise a system alarm for a pump timeout
* provide protection even if the normal control logic has a problem

### Current protection limits

```text
Minimum water level: 15 %
Maximum pump runtime: 30 seconds
Protection check interval: 2 seconds
```

A low-water-level protection stop does **not** automatically create an alarm. The normal controller will prevent another pump start while the water status remains critical.

A pump timeout does create a latched system alarm:

```text
Pump cycle timeout
```

---

# Alarm system

The alarm is implemented using two Shelly virtual components:

```text
boolean:200  → Waterworks Alarm
text:201     → Waterworks Alarm Reason
```

The alarm is a **system state**, not a water-level alarm.

An active alarm prevents a new pump cycle from starting.

The current system alarm is volatile and is cleared by restarting the Shelly.

Current alarm reasons include:

* `Pump cycle timeout`
* `Unknown water level value`
* `Low expansion tank pressure`

---

# MQTT

The MQTT base topic is:

```text
Waterworks/
```

Important published topics include:

```text
Waterworks/analog
Waterworks/status
Waterworks/input/0
Waterworks/relay/0/state
Waterworks/alarm/active
Waterworks/alarm/errormsg
Waterworks/enabled/state
Waterworks/warning_override/state
```

Command topics:

```text
Waterworks/enabled/set
Waterworks/warning_override/set
```

All relevant state values are published as retained MQTT messages.

---

# Home Assistant

The system uses **Home Assistant MQTT Discovery**.

No direct Home Assistant API is required.

The following entities are exposed:

* Water level
* Water status
* Pressure switch
* Pump state
* Alarm
* Alarm reason
* Waterworks Enabled
* Warning Override

Home Assistant can therefore be used as the user interface while the actual control logic remains inside the Shelly.

---

# Startup behavior

On startup:

1. The pump is switched OFF.
2. Alarm virtual components are initialized.
3. The current water level and pressure-switch state are read.
4. The water status is evaluated.
5. Normal event monitoring starts.
6. MQTT communication and Home Assistant discovery are initialized.
7. The controller evaluates whether a pump cycle is allowed.

The Watch Dog also starts with the pump forced OFF.

---

# Safety architecture

The system intentionally uses two layers:

```text
                  ┌──────────────────────┐
                  │      Main Control    │
                  │                      │
Pressure switch ─►│ Normal pump control  │
Water level ─────►│ State evaluation     │
MQTT / HA ───────►│ User controls        │
                  │ Short-cycle detection│
                  └──────────┬───────────┘
                             │
                             ▼
                            Pump
                             ▲
                             │
                  ┌──────────┴───────────┐
                  │       Watch Dog      │
                  │                      │
                  │ Low-water protection │
                  │ Runtime protection   │
                  │ Safety shutdown      │
                  │ System alarm         │
                  └──────────────────────┘
```

The Main script decides **whether the pump should normally run**.

The Watch Dog independently decides **whether the pump must be stopped for safety**.

This separation is intentional.

---

# Installation

## Requirements

* Shelly 2PM Gen4
* Shelly scripting enabled
* MQTT broker
* Home Assistant (optional)
* Analog water-level sensor connected to `input:100`
* Pressure switch connected to `input:0`
* Pump connected to relay 0

Upload both scripts to the Shelly and enable them.

Both scripts use the same virtual alarm component IDs:

```text
200 = Alarm
201 = Alarm reason
```

They are therefore intended to run together on the same device.

---

# Configuration

The most important parameters are located near the beginning of the scripts.

### Main controller

```javascript
const MIN_LEVEL_PERCENT = 15;
const WARNING_LEVEL_PERCENT = 30;
const HYSTERESIS = 2;

const SHORT_CYCLE_THRESHOLD_MS = 5 * 1000;
const SHORT_CYCLE_COUNT_THRESHOLD = 5;
```

### Watch Dog

```javascript
const MIN_LEVEL_PERCENT = 15;
const PUMP_RUNTIME_MS = 30 * 1000;
const PROTECTION_CHECK_MS = 2000;
```

Modify these values only after considering the behavior of both control layers.

---

# Design principles

The current implementation follows several deliberate principles:

1. **A normal pump cycle is allowed to finish.**
2. Water-level states primarily control permission for the next cycle.
3. `CRITICAL` can never be overridden.
4. The Watch Dog is independent from normal regulation.
5. Safety shutdowns do not automatically imply a system alarm.
6. Serious protection failures are reported as system alarms.
7. Pump short-cycle detection is based on actual relay transitions.
8. MQTT is used both for telemetry and user controls.
9. Home Assistant is an interface, not the core controller.
10. The two Shelly scripts should remain independently understandable.

---

# Current status

**Version 1.0**

The current implementation is considered the production baseline. It is installed and running since September 2026 without any issue. 
The whole solution was developed and is tested with Domoticz only. There was no test with HA yet.

Future changes should be made deliberately and tested against the existing behavior, especially the separation between:

* normal regulation
* water-level state handling
* Warning Override
* short-cycle detection
* Watch Dog protection
* system alarms

---

