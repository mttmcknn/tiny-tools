export interface ClockRuntime {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

// Use the platform's abortable timer; no spinning, polling, fetches, or background work.
export const workerClock: ClockRuntime = {
  now: () => Date.now(),
  wait: (ms, signal) => scheduler.wait(ms, { signal }),
};

export const CLOCK_SOURCE = "server_runtime_Date.now_last_IO";

export function currentTime(runtime: ClockRuntime, maxSleepMs: number) {
  const epochMs = runtime.now();
  return {
    utc: new Date(epochMs).toISOString(),
    epoch_ms: epochMs,
    epoch_seconds: epochMs / 1_000,
    clock_source: CLOCK_SOURCE,
    max_sleep_ms: maxSleepMs,
  };
}

export async function sleep(ms: number, runtime: ClockRuntime, signal: AbortSignal) {
  const start = runtime.now();
  let cancelled = false;
  try {
    signal.throwIfAborted();
    // Even a zero delay yields to the runtime before observing the end timestamp.
    await runtime.wait(ms, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (!signal.aborted) throw error;
    cancelled = true;
  }
  const end = runtime.now();
  const elapsed = end - start;
  const status = cancelled ? "cancelled" : elapsed < 0 ? "clock_moved_backwards" : elapsed < ms ? "timer_returned_early" : "completed";
  return {
    status,
    started_at_utc: new Date(start).toISOString(),
    ended_at_utc: new Date(end).toISOString(),
    start_epoch_ms: start,
    end_epoch_ms: end,
    requested_duration_ms: ms,
    actual_elapsed_ms: elapsed,
    difference_ms: elapsed - ms,
    clock_source: CLOCK_SOURCE,
  };
}
