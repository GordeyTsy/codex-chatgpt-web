// Browser-only discovery. Never generates a model response or interrupts an active turn.
class CapabilityMonitor {
  constructor({ host, supervisor, logger, intervalMs = 60 * 60 * 1000,
    retryMs = 60 * 1000, fetchImpl = fetch, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { host, supervisor, logger, intervalMs, retryMs, fetchImpl, schedule, cancel });
    this.timer = null;
    this.stopped = true;
    this.running = false;
  }
  start() { this.stopped = false; this.arm(0); }
  stop() { this.stopped = true; if (this.timer) this.cancel(this.timer); this.timer = null; }
  arm(ms) {
    if (this.stopped) return;
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(() => { this.timer = null; void this.check(); }, ms);
    this.timer?.unref?.();
  }
  async check() {
    if (this.stopped || this.running) return;
    this.running = true;
    let delay = this.retryMs;
    try {
      const config = this.supervisor.readConfig();
      if (!config || config.browserInteractionMode === "manual") { delay = this.intervalMs; return; }
      if (this.host.activeTraceId || this.host.currentOperation()) return;
      const health = await this.supervisor.proxyHealthPayload(config);
      if (!health || health.active_http_turns !== 0 || health.active_browser_turns !== 0) return;
      // inspectSession takes the launcher's manual-operation lease and refuses a racing turn.
      const observed = await this.host.inspectSession(true);
      if (this.stopped) return;
      if (observed.proSelectable === true) {
        const response = await this.fetchImpl(`http://${config.host}:${config.port}/admin/pro-available`, {
          method: "POST", headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
          body: JSON.stringify({ proSelectable: true }), signal: AbortSignal.timeout(5000),
        });
        if (response.status === 409) return;
        if (!response.ok) throw new Error(`Capability update HTTP ${response.status}`);
      }
      // A negative hourly observation is not a failed attempt to select Pro.
      this.logger.info("models.picker_checked", { proSelectable: observed.proSelectable === true });
      delay = this.intervalMs;
    } catch (error) {
      this.logger.warn("models.picker_check_deferred", { error: error instanceof Error ? error.name : "Error" });
    } finally { this.running = false; this.arm(delay); }
  }
}
module.exports = { CapabilityMonitor };
