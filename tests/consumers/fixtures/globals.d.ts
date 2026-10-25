export {};

declare global {
  interface Window {
    __probe?: unknown;
    __react?: { version: string; calls: Array<{ name: string; aborted: boolean }> };
  }
}
