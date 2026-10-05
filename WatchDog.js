/************************************************
 * Domestic Waterworks
 * Watchdog
 * Ver 1.0
 ************************************************/

const MIN_LEVEL_PERCENT = 15;
const PUMP_RUNTIME_MS = 30 * 1000;
const PROTECTION_CHECK_MS = 2000;

const ALARM_BOOL_ID = 200;
const ALARM_TEXT_ID = 201;

/************************************************
 * Internal global variables
 ************************************************/

let pumpStartTime = null;

/************************************************
 * Pump protection
 ************************************************/

function stopPump(reason) {
  
  Shelly.call("Switch.Set", {
    id: 0,
    on: false
  });
  
  pumpStartTime = null;

  print("Pump STOP:", reason);
}

function checkPumpTimeout(status) {

  let pumpOn =
    status["switch:0"] &&
    status["switch:0"].output === true;

  if (!pumpOn) {
    pumpStartTime = null;
    return;
  }

  if (pumpStartTime === null) {
    pumpStartTime = Shelly.getUptimeMs();
    return;
  }

  if (Shelly.getUptimeMs() - pumpStartTime > PUMP_RUNTIME_MS) {

    stopPump("timeout");
    raiseAlarm("Pump cycle timeout");
  }
}

function checkWaterLevel(status) {

  let pumpOn =
    status["switch:0"] &&
    status["switch:0"].output === true;

  if (!pumpOn) {
    return;
  }
  
  if (status["input:100"] && status["input:100"].percent !== undefined && status["input:100"].percent !== null) {
    let percent = status["input:100"].percent;
    print("Water level check:", percent);

      if (percent <= MIN_LEVEL_PERCENT) {
        stopPump("low water level");
      }
    }
    else {
      stopPump("unknown water level value");
      raiseAlarm("Unknown water level value");
    }
}

function watchDog() {
  
  
  Shelly.call("Shelly.GetStatus", {}, function(res, err) {

    if (err || !res) {
      return;
    }
  
    checkWaterLevel(res);
    checkPumpTimeout(res);
  });
}

function ensureAlarmComponents(callback) {

  Shelly.call("Virtual.Add", {
    type: "boolean",
    id: ALARM_BOOL_ID,
    config: { name: "Vodarna Alarm", persisted: false, default_value: false }
  }, function (res, err) {

    Shelly.call("Virtual.Add", {
      type: "text",
      id: ALARM_TEXT_ID,
      config: { name: "Vodarna Alarm Reason", persisted: false, default_value: "System OK" }
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

/************************************************
 * Startup
 ************************************************/

stopPump("startup reset");

ensureAlarmComponents();
Timer.set(PROTECTION_CHECK_MS, true, watchDog);

print("Watch dog started");
