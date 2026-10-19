// Virtual time for tests. sleep() doesn't wait: sleepers wake in the order of their wake times, and the clock jumps
// to each one's time as it wakes, so parallel calls spaced by a rate limit see the times they would see for real,
// without a test taking real time.
export class VirtualClock {
  private time: number;
  private sleepers: { at: number; seq: number; wake: () => void }[] = [];
  private seq = 0;
  private scheduled = false;

  constructor(start: number) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  /** Moves the clock forward by hand, for tests about expiry. */
  advance(ms: number): void {
    this.time += ms;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((wake) => {
      this.sleepers.push({ at: this.time + Math.max(0, ms), seq: this.seq++, wake });
      this.sleepers.sort((left, right) => left.at - right.at || left.seq - right.seq);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // After the current microtasks, so every sleep started in the same step is queued before the earliest wakes.
    setImmediate(() => {
      this.scheduled = false;
      const next = this.sleepers.shift();
      if (!next) return;
      this.time = Math.max(this.time, next.at);
      next.wake();
      if (this.sleepers.length) this.schedule();
    });
  }
}
