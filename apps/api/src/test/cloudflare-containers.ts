export class Container<Env extends { containerFetch?: (request: Request) => Promise<Response> }> {
  readonly ctx: { storage: unknown };
  readonly env: Env;
  envVars: Record<string, string> = {};

  constructor(ctx: { storage: unknown }, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async startAndWaitForPorts(): Promise<void> {}

  async destroy(): Promise<void> {}

  async containerFetch(request: Request): Promise<Response> {
    if (!this.env.containerFetch) throw new Error("No test containerFetch configured");
    return this.env.containerFetch(request);
  }

  async schedule(when: Date | number, _callback: string, _payload?: unknown): Promise<void> {
    const storage = this.ctx.storage as { setAlarm?: (time: number) => Promise<void> };
    await storage.setAlarm?.(when instanceof Date ? when.getTime() : when);
  }

  deleteSchedules(_callback: string): void {}

  async alarm(_alarmProps?: unknown): Promise<void> {}
}
