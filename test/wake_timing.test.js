const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { getHourInTimeZone } = require("../time_utils");

// 批注 2026-10-20：随机唤醒时刻。随机源通过 setRandomSource 注入，测试不依赖真实随机数。
const TIME_ZONE = "Europe/London";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-wake-timing-"));
const TIMING_KEYS = [
  "DAY_CHECK_INTERVAL_MINUTES",
  "NIGHT_CHECK_INTERVAL_MINUTES",
  "DAY_CHECK_INTERVAL_JITTER_MINUTES",
  "NIGHT_CHECK_INTERVAL_JITTER_MINUTES",
  "WAKE_INTERVAL_MAX_MINUTES",
  "DAY_WAKE_AFTER_MINUTES",
  "NIGHT_WAKE_AFTER_MINUTES",
  "WAKE_AFTER_JITTER_MINUTES",
  "WAKE_DAY_START_HOUR",
  "WAKE_DAY_END_HOUR"
];

Object.assign(process.env, { WAKE_UP_NO_AUTOSTART: "1", DATA_DIR: dataDir, TIME_ZONE });
const wake = require("../wake_up");

function withEnv(values) {
  for (const key of TIMING_KEYS) delete process.env[key];
  // 默认全天都是“白天”，避免测试结果随运行时刻变化。
  Object.assign(process.env, { WAKE_DAY_START_HOUR: "0", WAKE_DAY_END_HOUR: "24" }, values);
}

function forceNight() {
  const hour = getHourInTimeZone(new Date(), TIME_ZONE);
  process.env.WAKE_DAY_START_HOUR = String((hour + 1) % 24);
  process.env.WAKE_DAY_END_HOUR = String(((hour + 2) % 24) || 24);
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

test.after(() => {
  wake.setRandomSource(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("jitter 0 keeps the old fixed interval and threshold", () => {
  withEnv({ DAY_CHECK_INTERVAL_MINUTES: "10", DAY_WAKE_AFTER_MINUTES: "60" });
  for (const r of [0, 0.5, 0.9999]) {
    wake.setRandomSource(() => r);
    assert.equal(wake.getCheckIntervalMs(), 10 * 60 * 1000);
  }
  wake.setRandomSource(() => 0.9999);
  assert.equal(wake.shouldWake(minutesAgo(59)), false);
  assert.equal(wake.shouldWake(minutesAgo(60)), true);

  withEnv({});
  assert.equal(wake.getCheckIntervalMs(), 10 * 60 * 1000, "default day interval unchanged");
  forceNight();
  assert.equal(wake.getCheckIntervalMs(), 120 * 60 * 1000, "default night interval unchanged");
});

test("randomized interval stays within base ± jitter and under the cap", () => {
  withEnv({ DAY_CHECK_INTERVAL_MINUTES: "45", DAY_CHECK_INTERVAL_JITTER_MINUTES: "12" });
  wake.setRandomSource(() => 0);
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 33);
  wake.setRandomSource(() => 0.5);
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 45);
  wake.setRandomSource(() => 0.999999);
  assert.ok(Math.abs(wake.getRandomizedCheckIntervalMinutes() - 57) < 0.001);

  process.env.WAKE_INTERVAL_MAX_MINUTES = "50";
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 50, "capped by WAKE_INTERVAL_MAX_MINUTES");

  wake.setRandomSource(Math.random);
  for (let i = 0; i < 2000; i++) {
    const minutes = wake.getRandomizedCheckIntervalMinutes();
    assert.ok(minutes >= 33 && minutes <= 50, `out of bounds: ${minutes}`);
    const ms = wake.getCheckIntervalMs();
    assert.ok(ms >= 33 * 60 * 1000 && ms <= 50 * 60 * 1000);
  }
});

test("randomized interval never drops below one minute", () => {
  withEnv({ DAY_CHECK_INTERVAL_MINUTES: "2", DAY_CHECK_INTERVAL_JITTER_MINUTES: "10" });
  wake.setRandomSource(() => 0);
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 1);
});

test("night uses its own interval and jitter, and the cap applies there too", () => {
  withEnv({
    DAY_CHECK_INTERVAL_MINUTES: "45",
    DAY_CHECK_INTERVAL_JITTER_MINUTES: "12",
    NIGHT_CHECK_INTERVAL_MINUTES: "120",
    NIGHT_CHECK_INTERVAL_JITTER_MINUTES: "20"
  });
  forceNight();
  wake.setRandomSource(() => 0);
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 100);
  process.env.WAKE_INTERVAL_MAX_MINUTES = "57";
  assert.equal(wake.getRandomizedCheckIntervalMinutes(), 57);
});

test("silence threshold offset is drawn once per silence period", () => {
  withEnv({ DAY_WAKE_AFTER_MINUTES: "60", WAKE_AFTER_JITTER_MINUTES: "60" });
  const firstSilence = minutesAgo(80);

  wake.setRandomSource(() => 0.5);
  assert.equal(wake.getWakeAfterOffsetMinutes(firstSilence), 30);
  // 同一段沉默里随机源变了也不重抽：阈值保持 60 + 30 = 90 分钟。
  wake.setRandomSource(() => 0.9);
  assert.equal(wake.getWakeAfterOffsetMinutes(firstSilence), 30);
  assert.equal(wake.shouldWake(firstSilence), false);
  assert.equal(wake.shouldWake(new Date(firstSilence.getTime())), false, "same time, new Date object");
  assert.equal(wake.shouldWake(minutesAgo(90)), false, "different message time draws a new offset (54)");

  // 用户发了新消息：最后一条用户消息时间变了，重新抽取。
  const secondSilence = minutesAgo(100);
  wake.setRandomSource(() => 0.25);
  assert.equal(wake.getWakeAfterOffsetMinutes(secondSilence), 15);
  assert.equal(wake.shouldWake(secondSilence), true);
  wake.setRandomSource(() => 0.99);
  assert.equal(wake.getWakeAfterOffsetMinutes(secondSilence), 15);

  withEnv({ DAY_WAKE_AFTER_MINUTES: "60" });
  assert.equal(wake.getWakeAfterOffsetMinutes(secondSilence), 0, "jitter 0 means no offset");
});
