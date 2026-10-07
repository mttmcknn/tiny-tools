import assert from "node:assert/strict";
import test from "node:test";
import { CLOCK_SOURCE, currentTime, sleep, type ClockRuntime } from "../src/clock.ts";
import { DEFAULT_MAX_SLEEP_MS, HARD_MAX_SLEEP_MS, readConfig } from "../src/config.ts";

const BASE = Date.parse("2026-10-01T12:34:56.789Z");

function advancingClock(elapsed: number) {
  let now = BASE;
  const calls: number[] = [];
  const runtime: ClockRuntime = {
    now: () => now,
    async wait(ms, signal) {
      signal.throwIfAborted();
      calls.push(ms);
      now += elapsed;
    },
  };
  return { runtime, calls };
}

test("current_time returns consistent UTC, epoch seconds, and configured bound", () => {
  const { runtime } = advancingClock(0);
  const value = currentTime(runtime, 100);
  assert.equal(value.utc, "2026-10-01T12:34:56.789Z");
  assert.equal(Date.parse(value.utc), value.epoch_ms);
  assert.equal(value.epoch_ms, BASE);
  assert.equal(value.epoch_seconds * 1_000, BASE);
  assert.equal(value.clock_source, CLOCK_SOURCE);
  assert.equal(value.max_sleep_ms, 100);
});

for (const [elapsed, status] of [[100, "completed"], [112, "completed"], [88, "timer_returned_early"], [-1, "clock_moved_backwards"]] as const) {
  test(`sleep reports ${status} with the observed elapsed duration ${elapsed} ms`, async () => {
    const { runtime, calls } = advancingClock(elapsed);
    const value = await sleep(100, runtime, new AbortController().signal);
    assert.deepEqual(calls, [100]);
    assert.equal(value.status, status);
    assert.equal(value.requested_duration_ms, 100);
    assert.equal(value.actual_elapsed_ms, elapsed);
    assert.equal(value.difference_ms, elapsed - 100);
    assert.equal(value.end_epoch_ms - value.start_epoch_ms, value.actual_elapsed_ms);
    assert.equal(Date.parse(value.started_at_utc), value.start_epoch_ms);
    assert.equal(Date.parse(value.ended_at_utc), value.end_epoch_ms);
  });
}

test("zero duration still yields once before recording its end timestamp", async () => {
  const { runtime, calls } = advancingClock(1);
  const value = await sleep(0, runtime, new AbortController().signal);
  assert.deepEqual(calls, [0]);
  assert.equal(value.status, "completed");
  assert.equal(value.requested_duration_ms, 0);
  assert.equal(value.actual_elapsed_ms, 1);
});

test("an already cancelled sleep never schedules a wait", async () => {
  const { runtime, calls } = advancingClock(100);
  const controller = new AbortController();
  controller.abort();
  const value = await sleep(100, runtime, controller.signal);
  assert.equal(value.status, "cancelled");
  assert.equal(value.actual_elapsed_ms, 0);
  assert.deepEqual(calls, []);
});

test("cancellation passes through to the wait and removes pending work", async () => {
  const controller = new AbortController();
  let now = BASE;
  let pending = 0;
  let observedSignal: AbortSignal | undefined;
  const runtime: ClockRuntime = {
    now: () => now,
    wait(_ms, signal) {
      observedSignal = signal;
      pending++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          pending--;
          now += 7;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const result = sleep(100, runtime, controller.signal);
  assert.equal(pending, 1);
  assert.equal(observedSignal, controller.signal);
  controller.abort();
  const value = await result;
  assert.equal(value.status, "cancelled");
  assert.equal(value.actual_elapsed_ms, 7);
  assert.equal(pending, 0);
});

test("unexpected timer failures propagate instead of claiming cancellation", async () => {
  const failure = new Error("timer unavailable");
  await assert.rejects(sleep(100, { now: () => BASE, wait: async () => { throw failure; } }, new AbortController().signal), failure);
});

test("configuration accepts its default and both explicit limit boundaries", () => {
  assert.equal(readConfig({}).maxSleepMs, DEFAULT_MAX_SLEEP_MS);
  assert.equal(readConfig({ MAX_SLEEP_MS: "1" }).maxSleepMs, 1);
  assert.equal(readConfig({ MAX_SLEEP_MS: String(HARD_MAX_SLEEP_MS) }).maxSleepMs, HARD_MAX_SLEEP_MS);
  assert.deepEqual(readConfig({ ALLOWED_HOSTNAMES: " example.workers.dev, localhost " }).allowedHostnames, ["example.workers.dev", "localhost"]);
});

test("configuration rejects nonfinite, fractional, out-of-range and empty values", () => {
  for (const raw of ["", " ", "0", "-1", "1.5", "1e3", "NaN", "Infinity", String(HARD_MAX_SLEEP_MS + 1), "9007199254740992"]) {
    assert.throws(() => readConfig({ MAX_SLEEP_MS: raw }), /MAX_SLEEP_MS/);
  }
  assert.throws(() => readConfig({ ALLOWED_HOSTNAMES: " , " }), /ALLOWED_HOSTNAMES/);
});
