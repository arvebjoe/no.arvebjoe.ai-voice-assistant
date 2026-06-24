// Shim for the `homey-log` package (Sentry-style crash reporting). The emulator
// has no cloud backend, so every method is a no-op.
export class Log {
  constructor(_opts?: any) {}
  async captureException(_e?: any): Promise<void> {}
  async captureMessage(_m?: any): Promise<void> {}
  setTags(_t?: any): void {}
  setUser(_u?: any): void {}
  setExtra(_k?: any, _v?: any): void {}
}

export default { Log };
