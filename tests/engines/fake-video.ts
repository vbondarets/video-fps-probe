export interface FakeVideoConfig {
  hz: number;
  times: ArrayLike<number>;
  duration: number;
  failure?: string;
  canPlay?: string;
  width?: number;
}

export function uniformTimes(fps: number, seconds: number): number[] {
  const out: number[] = [];
  for (let i = 0; i / fps < seconds; i++) out.push(i / fps);
  return out;
}

export function patternTimes(deltas: readonly number[], seconds: number): number[] {
  const out: number[] = [0];
  for (let i = 0; out[out.length - 1] < seconds; i++) out.push(out[out.length - 1] + deltas[i % deltas.length]);
  return out;
}

interface FrameMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type FrameCallback = (now: number, metadata: FrameMetadata) => void;

export class FakeVideo {
  muted = false;
  playsInline = false;
  width = 0;
  videoWidth: number;
  videoHeight = 180;
  duration: number;
  error: { message: string; code: number } | null = null;
  playbackRate = 1;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  removed = false;
  hasSrc = false;
  readonly config: FakeVideoConfig;
  #callback: FrameCallback | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #time = 0;
  #playing = false;
  #startedAt = 0;
  #baseTime = 0;
  #presented = 0;
  #lastIndex = -1;

  constructor(config: FakeVideoConfig) {
    this.config = config;
    this.duration = config.duration;
    this.videoWidth = config.width ?? 320;
  }

  get currentTime(): number {
    return this.#time;
  }

  set currentTime(value: number) {
    this.#time = value;
    this.#lastIndex = -1;
  }

  set src(value: string) {
    this.hasSrc = value !== '';
    if (value === '') return;
    setTimeout(() => {
      if (this.config.failure) {
        this.error = { message: this.config.failure, code: 4 };
        this.onerror?.();
      } else {
        this.onloadedmetadata?.();
      }
    }, 5);
  }

  canPlayType(): string {
    return this.config.canPlay ?? '';
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.hasSrc = false;
  }

  load(): void {}

  remove(): void {
    this.removed = true;
  }

  requestVideoFrameCallback(callback: FrameCallback): number {
    this.#callback = callback;
    return 1;
  }

  async play(): Promise<void> {
    if (this.#playing) return;
    if (this.#time >= this.duration) this.currentTime = 0;
    this.#playing = true;
    this.#startedAt = performance.now();
    this.#baseTime = this.#time;
    this.#timer = setTimeout(this.#tick, 1000 / this.config.hz);
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    clearTimeout(this.#timer);
  }

  #indexAt(mediaTime: number): number {
    const times = this.config.times;
    let lo = 0;
    let hi = times.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= mediaTime + 1e-9) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  #tick = (): void => {
    if (!this.#playing) return;
    const now = performance.now();
    const mediaTime = this.#baseTime + ((now - this.#startedAt) / 1000) * this.playbackRate;
    this.#time = Math.min(mediaTime, this.duration);
    if (mediaTime >= this.duration) {
      this.#playing = false;
      this.onended?.();
      return;
    }
    const index = this.#indexAt(mediaTime);
    if (index > this.#lastIndex) {
      this.#lastIndex = index;
      this.#presented++;
      const callback = this.#callback;
      if (callback) {
        this.#callback = null;
        callback(now, { mediaTime: this.config.times[index], presentedFrames: this.#presented });
      }
    }
    if (this.#playing) this.#timer = setTimeout(this.#tick, 1000 / this.config.hz);
  };
}
