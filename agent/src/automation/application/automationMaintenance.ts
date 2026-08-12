import type { AutomationService } from "./automationService.js";

export class AutomationMaintenance {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly service: AutomationService,
    private readonly intervalSeconds: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.service.runMaintenanceCycle();
      if (
        result.scheduled ||
        result.modelConfigurationsInvalidated ||
        result.aiInteractionsPurged ||
        result.traceEventsPurged
      ) {
        console.error(`[automation-maintenance] ${JSON.stringify(result)}`);
      }
    } catch (error) {
      console.error(
        `[automation-maintenance] cycle failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(
          () => void this.tick(),
          this.intervalSeconds * 1000,
        );
        this.timer.unref();
      }
    }
  }
}
