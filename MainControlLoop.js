/************************************************
 * Domestic Waterworks
 * Main Control Loop
 * Ver 1.0
 ************************************************/

const DEVICE_NAME = "Waterworks";
const BASE_TOPIC = "Waterworks";
const DISCOVERY_PREFIX = "homeassistant";

const PERIODIC_MQTTUPDATE_MS = 5 * 60 * 1000;
const MIN_LEVEL = 15;
const WARNING_LEVEL = 30;
const HYSTERESIS = 2;
const SHORT_CYCLE_THRESHOLD_MS = 5* 1000;
const SHORT_CYCLE_COUNT_THRESHOLD = 5;

const ALARM_BOOL_ID = 200;
const ALARM_TEXT_ID = 201;

/************************************************
 * Internal global variables
 ************************************************/
 
let deviceId = "";
let lastAnalog = -1;

let mqttSubscribed = false;
let mqttReadyTimer1 = null;
let mqttReadyTimer2 = null;
let discoveryRunning = false;
let discoveryPublished = false;

let controlInitialized = false;
let controlInitTimer = null;

let waterworksEnabled = true;
let warningOverride = false;
let pressureDemand = false;
let waterLevel = 100;
let waterStatus = "NORMAL";
let pumpRunStartTime = null;
let shortCycleCount = 0;
let alarmActive = false;

/************************************************
 * Helper functions
 ************************************************/

function topic(path) {

  return BASE_TOPIC + "/" + path;
}

function discoveryTopic(component, objectId) {

  return DISCOVERY_PREFIX + "/" +
         component + "/" +
         objectId + "/config";
}

function scheduleDiscovery(delay) {

  if (discoveryRunning) return;
  discoveryRunning = true;

  Timer.set(delay || 5000, false, function () {

    Shelly.call("MQTT.GetStatus", {}, function (res, err) {

      if (!res || err || !res.connected || !deviceId) {
        print("Discovery postponed");
        discoveryRunning = false;
        scheduleDiscovery(Math.min((delay || 5000) * 2, 60000));
        return;
      }

      publishHADiscovery();
      discoveryRunning = false;
      discoveryPublished = true;
    });
  });
}

function mqttPublish(path, payload, retain) { 
  MQTT.publish( 
    topic(path), 
    payload, 
    0, 
    retain || false 
  ); 
}

function mqttPublishDiscovery(component, objectId, payload) {

  MQTT.publish(
    discoveryTopic(component, objectId),
    JSON.stringify(payload),
    0,
    true
  );
}

function sendAnalog(percent) {

  if (percent === null || percent === undefined) {
    print("Analog value not ready");
    return;
  }

  lastAnalog = percent;
  waterLevel = percent;

  updateWaterStatus();
  mqttPublish("analog", percent.toFixed(1), true);
}

function sendRelay(id, state) {

  mqttPublish("relay/" + id + "/state", state ? "ON" : "OFF", true);
}

function sendInput(id, state) {

  mqttPublish("input/" + id, state ? "ON" : "OFF", true);
}

function sendVirtualSwitch(id, state) {
  mqttPublish(id, state ? "ON" : "OFF", true);
}

function ensureAlarmComponents(callback) {

  Shelly.call("Virtual.Add", {
    type: "boolean",
    id: ALARM_BOOL_ID,
    config: { name: "Waterworks Alarm", persisted: false, default_value: false }
  }, function (res, err) {

    Shelly.call("Virtual.Add", {
      type: "text",
      id: ALARM_TEXT_ID,
      config: { name: "Waterworks Alarm Reason", persisted: false, default_value: "System OK" }
    }, function (res2, err2) {

      if (callback) callback();
    });
  });
}

function raiseAlarm(reason) {

  Shelly.call("Boolean.Set", { id: ALARM_BOOL_ID, value: true });
  Shelly.call("Text.Set", { id: ALARM_TEXT_ID, value: reason });

  print("ALARM:", reason);
}

function withStatus(res, callback) {

  if (res) {
    callback(res);
    return;
  }

  Shelly.call("Shelly.GetStatus", {}, function (res, err) {

    if (err || !res) {
      print("Status read error");
      return;
    }

    callback(res);
  });
}

/************************************************
 * Publish sensors, inputs and relay
 ************************************************/

function publishRelayStates(res) {

  withStatus(res, function (res) {

    if (res["switch:0"] && res["switch:0"].output !== undefined) {
      sendRelay("0", res["switch:0"].output);
    }
  });
}

function publishInputStates(res) {

  withStatus(res, function (res) {

    if (res["input:0"] && res["input:0"].state !== undefined) {
      sendInput("0", res["input:0"].state);
    }
  });
}

function publishSensors(res) {

  withStatus(res, function (res) {

    if (res["input:100"] && res["input:100"].percent !== undefined && res["input:100"].percent !== null) {
      let percent = res["input:100"].percent;
      print("Analog percent:", percent);
      sendAnalog(percent);
    }
    else {
       print("Analog value not available");
       raiseAlarm("Unknown water level value");
    }
  });
}

function publishVirtualSwitches() {

  sendVirtualSwitch("enabled/state", waterworksEnabled);
  sendVirtualSwitch("warning_override/state", warningOverride);
  mqttPublish("status", waterStatus, true);
}

function publishAlarmState() {

  Shelly.call("Boolean.GetStatus", { id: ALARM_BOOL_ID }, function (res, err) {

    if (!err && res && res.value !== undefined) {
      alarmActive = res.value;
      mqttPublish("alarm/active", res.value ? "ON" : "OFF", true);
    }

    Shelly.call("Text.GetStatus", { id: ALARM_TEXT_ID }, function (res2, err2) {

      if (!err2 && res2 && res2.value !== undefined) {
        mqttPublish("alarm/errormsg", res2.value, true);
      }
    });
  });
}

/********************************************
 * HA Discovery
 ********************************************/
   
function publishHADiscovery() {

  let items = [
    ["sensor", deviceId + "_analog", { name: DEVICE_NAME + " Water level", unique_id: deviceId + "_analog", stat_t: topic("analog"), unit_of_meas: "%", stat_cla: "measurement" }],
    ["sensor", deviceId + "_status", { name: DEVICE_NAME + " Status", unique_id: deviceId + "_status", stat_t: topic("status"), device_class: "enum", options: ["NORMAL", "WARNING", "CRITICAL"] }],
    ["binary_sensor", deviceId + "_input_0", { name: DEVICE_NAME + " Pressure switch", unique_id: deviceId + "_input_0", stat_t: topic("input/0"), pl_on: "ON", pl_off: "OFF" }],
    ["binary_sensor", deviceId + "_pump", { name: DEVICE_NAME + " Pump", unique_id: deviceId + "_pump", stat_t: topic("relay/0/state"), pl_on: "ON", pl_off: "OFF" }],
    ["binary_sensor", deviceId + "_alarm", { name: DEVICE_NAME + " Alarm", unique_id: deviceId + "_alarm", stat_t: topic("alarm/active"), pl_on: "ON", pl_off: "OFF", device_class: "problem" }],
    ["sensor", deviceId + "_errormsg", { name: DEVICE_NAME + " Error message", unique_id: deviceId + "_errormsg", stat_t: topic("alarm/errormsg") }],
    ["switch", deviceId + "_enabled", { name: DEVICE_NAME + " Enabled", unique_id: deviceId + "_enabled", stat_t: topic("enabled/state"), cmd_t: topic("enabled/set"), pl_on: "ON", pl_off: "OFF" }],
    ["switch", deviceId + "_warning_override", { name: DEVICE_NAME + " Warning Override", unique_id: deviceId + "_warning_override", stat_t: topic("warning_override/state"), cmd_t: topic("warning_override/set"), pl_on: "ON", pl_off: "OFF" }],

  ];

  let i = 0;

  function sendNext() {
    
    if (i >= items.length) {
      return;
    }

    let item = items[i++];
    print("Discovery item:", item[0], item[1]);
    mqttPublishDiscovery(item[0], item[1], item[2]);
    Timer.set(200, false, sendNext);
  }

  sendNext();
 
  print("MQTT discovery published");
}

/************************************************
 * MQTT subscriptions
 ************************************************/

function mqttSubscribe() {

  if (mqttSubscribed) {
    return;
  }
  
  MQTT.subscribe(topic("enabled/set"), function(topic, msg) {

    let enabled = (msg || "").toUpperCase() === "ON";
    waterworksEnabled = enabled;

    if (!enabled) {
        warningOverride = false;
        sendVirtualSwitch("warning_override/state", warningOverride);    
    }
    sendVirtualSwitch("enabled/state", waterworksEnabled);
    
    if (waterworksEnabled) {
      updatePump();
    }
  });

  MQTT.subscribe(topic("warning_override/set"), function(topic, msg) {

    let override = (msg || "").toUpperCase() === "ON";

    // CRITICAL nelze nikdy obejít
    if (waterStatus === "CRITICAL") {
        override = false;
    }

    warningOverride = override;
    sendVirtualSwitch("warning_override/state", warningOverride);

    if (warningOverride && waterStatus === "WARNING") {
      updatePump();
    }
  });

  mqttSubscribed = true;

  print("MQTT subscribe active");
}
  
/************************************************
 * Periodic sensor updates
 ************************************************/

function startPeriodicUpdate(interval) {
  Timer.set(interval, true, function () {

      print("Periodic update");

      Shelly.call("Shelly.GetStatus", {}, function (res, err) {

        if (err || !res) {
          print("Periodic status read error");
          return;
        }

        publishSensors(res);
        publishRelayStates(res);
        publishInputStates(res);

        publishAlarmState();
      });

      publishVirtualSwitches();
    }
  );
}

/************************************************
 * MQTT initial communication
 ************************************************/

function onMQTTReady() {

  print("MQTT READY");

  mqttSubscribe();
  
  if (!discoveryPublished) {
    scheduleDiscovery();
  }

  publishRelayStates();
  publishVirtualSwitches();
  publishAlarmState();

  if (mqttReadyTimer1) {
    Timer.clear(mqttReadyTimer1);
  }

  if (mqttReadyTimer2) {
    Timer.clear(mqttReadyTimer2);
  }
  
  mqttReadyTimer1 = Timer.set(200, false, function () {
    mqttReadyTimer1 = null;
    publishInputStates();
  });

  mqttReadyTimer2 = Timer.set(400, false, function () {
    mqttReadyTimer2 = null;
    publishSensors();
  });
}

/************************************************
 * Input and relay event handling
 ************************************************/

function startEventAndStatusHandler() {

  Shelly.addStatusHandler(function(e) {

    if (!e || !e.component || !e.delta) return;

    // -----------------------
    // ALARM active (boolean:200)
    // -----------------------
    if (e.component === "boolean:" + ALARM_BOOL_ID && e.delta.value !== undefined) {
      mqttPublish("alarm/active", e.delta.value ? "ON" : "OFF", true);
      alarmActive = e.delta.value;
      print("Alarm active:", e.delta.value);
      return;
    }

    // -----------------------
    // ALARM reason (text:201)
    // -----------------------
    if (e.component === "text:" + ALARM_TEXT_ID && e.delta.value !== undefined) {
      mqttPublish("alarm/errormsg", e.delta.value, true);
      print("Alarm reason:", e.delta.value);
      return;
    }
    
    // -----------------------
    // MQTT connected
    // -----------------------
    if (e.component === "mqtt" && e.delta && e.delta.connected === true) {
      print("MQTT connected");
      mqttSubscribed = false;
      onMQTTReady();
      return;
    }

    // -----------------------
    // RELAY state change
    // -----------------------
    if (e.component.indexOf("switch:") === 0) {
      let id = e.component.split(":")[1];
      let output = e.delta.output;
      if (output !== undefined) {               
        sendRelay(id, output);
        print("Relay", id, output);
        
        if (id === "0") {
          if (output) {
            pumpRunStartTime = Shelly.getUptimeMs();
          }
          else if (pumpRunStartTime !== null) {
            checkShortCycle(Shelly.getUptimeMs() - pumpRunStartTime);
            pumpRunStartTime = null;
          }
        }
      }
      return;
    }

    // -----------------------
    // ANALOG input change
    // -----------------------
    if (e.component === "input:100" && e.delta.percent !== undefined) {
      let percent = e.delta.percent;

      if (Math.abs(percent - lastAnalog) < 0.5) 
        return;
      
      sendAnalog(percent);
      print("Analog", percent);
      return;
    }

    // -----------------------
    // INPUT state change
    // -----------------------
    
    if (e.component.indexOf("input:") === 0) {
      let id = e.component.split(":")[1];
      let state = e.delta.state;

      if (state !== undefined) {
        sendInput(id, state);
        print("Input", id, state);

        if (id === "0") {
          pressureDemand = state;
          updatePump();
        }
      }

      return;
    }

  });
}

/************************************************
 * Main control routines
 ************************************************/

function updateWaterStatus() {

  const SEVERITY = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };
  let newStatus;

  if (waterLevel <= MIN_LEVEL) {
    newStatus = "CRITICAL";
  }
  else if (waterLevel <= WARNING_LEVEL) {
    newStatus = "WARNING";
  }
  else {
    newStatus = "NORMAL";
  }

  if (newStatus === waterStatus) {
    return;
  }

  if (SEVERITY[newStatus] < SEVERITY[waterStatus]) {
    const limit = newStatus === "NORMAL" ? WARNING_LEVEL : MIN_LEVEL;
    if (waterLevel <= limit + HYSTERESIS) {
      return;
    }
  }
  
  let oldStatus = waterStatus;
  waterStatus = newStatus;

  mqttPublish("status", waterStatus, true);

  print("Water status:", waterStatus);

  if (waterStatus === "NORMAL" && warningOverride) {
    warningOverride = false;
    sendVirtualSwitch("warning_override/state", warningOverride);
  }

  if (waterStatus === "CRITICAL" && warningOverride) {
    warningOverride = false;
    sendVirtualSwitch("warning_override/state", warningOverride);
  }
  
  if (oldStatus !== "NORMAL" && waterStatus === "NORMAL") {
    updatePump();
  }
}

function updatePump() {

  if (!controlInitialized) {
    return;
  }

  let pumpAllowed =
      waterworksEnabled &&
      !alarmActive &&
      waterStatus !== "CRITICAL" &&
      (
        waterStatus === "NORMAL" ||
        warningOverride
      );
   let pumpShouldRun =
      pumpAllowed &&
      pressureDemand;

  Shelly.call("Switch.Set", {
    id: 0,
    on: pumpShouldRun
  });
}

function initializeControl() {

  if (controlInitialized) {
    return;
  }

  Shelly.call("Shelly.GetStatus", {}, function(res, err) {

    if (err || !res) {
      print("Control initialization failed, retrying...");
      scheduleControlInitialization();
      return;
    }

    let levelReady =
      res["input:100"] &&
      res["input:100"].percent !== undefined &&
      res["input:100"].percent !== null;

    let pressureReady =
      res["input:0"] &&
      res["input:0"].state !== undefined;

    if (!levelReady || !pressureReady) {
      print("Control initialization waiting for inputs...");
      scheduleControlInitialization();
      return;
    }

    waterLevel = res["input:100"].percent;
    pressureDemand = res["input:0"].state;

    updateWaterStatus();

    print("Control initialized");
    print("Water level:", waterLevel);
    print("Water status:", waterStatus);
    print("Pressure demand:", pressureDemand);

    controlInitialized = true;

    updatePump();
  });
}

function scheduleControlInitialization() {

  if (controlInitTimer !== null) {
    return;
  }

  controlInitTimer = Timer.set(1000, false, function() {
    controlInitTimer = null;
    initializeControl();
  });
}

function initializeStartup() {

  ensureAlarmComponents(function () {
    Shelly.call("Switch.Set", {
      id: 0,
      on: false
    }, function(res, err) {

      if (err) {
        print("Failed to turn pump OFF during startup");
        return;
      }

      print("Pump OFF confirmed during startup");

      startEventAndStatusHandler();
      initializeControl();
      startPeriodicUpdate(PERIODIC_MQTTUPDATE_MS);
      onMQTTReady();
    });
  });
}

function checkShortCycle(durationMs) {

  print("Pump run duration:", durationMs);

  if (durationMs < SHORT_CYCLE_THRESHOLD_MS) {
    shortCycleCount++;
  }
  else {
    shortCycleCount = 0;
  }

  if (shortCycleCount >= SHORT_CYCLE_COUNT_THRESHOLD) {
    raiseAlarm("Low expansion tank pressure");
    shortCycleCount = 0;
  }
}

/************************************************
 * Startup
 ************************************************/

Shelly.call("Shelly.GetDeviceInfo", {}, function(res) {

  deviceId = res.id;
  print("Device ready:", deviceId);

  initializeStartup();
});

print("Shelly Domoticz bridge started");
