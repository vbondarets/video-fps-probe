export {};

declare global {
  interface Window {
    __probe?: unknown;
    __check?: { check: unknown; preset?: unknown };
    __react?: { version: string; calls: Array<{ name: string; aborted: boolean }>; hold(): void; release(): void };
  }
}
