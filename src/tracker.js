"use strict";

const { localDateKey } = require("./model");

class ActiveTracker {
  constructor({ onChange, now = Date.now, idleTimeoutMs = 300000, maxGapMs = 15000 } = {}) {
    if (typeof onChange !== "function" || typeof now !== "function") throw new TypeError("Tracker requires an onChange callback and a clock.");
    this.onChange = onChange;
    this.now = now;
    this.idleTimeoutMs = this.positiveNumber(idleTimeoutMs);
    this.maxGapMs = this.positiveNumber(maxGapMs);
    this.context = { focused: false, active: true, eligible: false, projectId: "", projectName: "" };
    this.paused = false;
    this.lastActivity = null;
    this.lastTick = this.timestamp();
  }

  positiveNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError("Tracker intervals must be positive finite numbers.");
    return value;
  }

  timestamp(value = this.now()) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new TypeError("Invalid tracker timestamp.");
    return value;
  }

  canTrack() {
    return !this.paused && this.context.focused && this.context.active !== false &&
      this.context.eligible && Boolean(this.context.projectId) && Boolean(this.context.projectName);
  }

  setContext(context, now) {
    const at = this.timestamp(now);
    this.tick(at);
    const next = { ...this.context, ...context };
    if (next.focused !== this.context.focused || next.active !== this.context.active ||
        next.eligible !== this.context.eligible || next.projectId !== this.context.projectId) {
      this.lastActivity = null;
    }
    this.context = next;
  }

  activity(now) {
    const at = this.timestamp(now);
    this.tick(at);
    if (this.canTrack()) this.lastActivity = at;
  }

  edit({ characters = 0, file } = {}, now) {
    if (!Number.isSafeInteger(characters) || characters < 0) throw new TypeError("Characters must be a nonnegative safe integer.");
    if (file && (typeof file.id !== "string" || !file.id || typeof file.path !== "string" || !file.path)) throw new TypeError("An edited file needs an ID and a path.");
    const at = this.timestamp(now);
    this.activity(at);
    if (!this.canTrack() || (!characters && !file)) return;
    this.onChange({
      date: localDateKey(new Date(at)),
      projectId: this.context.projectId,
      projectName: this.context.projectName,
      languageId: this.context.languageId || "unknown",
      seconds: 0,
      characters,
      ...(file ? { file: { ...file } } : {}),
    });
  }

  tick(now) {
    const at = this.timestamp(now);
    const start = this.lastTick;
    this.lastTick = at;
    // Sleep, a stalled extension host, and clock rollback cannot prove activity.
    if (at < start || at - start > this.maxGapMs) {
      this.lastActivity = null;
      return;
    }
    if (!this.canTrack() || this.lastActivity === null) return;
    const end = Math.min(at, this.lastActivity + this.idleTimeoutMs);
    let cursor = start;
    while (cursor < end) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const boundary = Math.min(end, midnight.getTime());
      this.onChange({
        date: localDateKey(new Date(cursor)),
        projectId: this.context.projectId,
        projectName: this.context.projectName,
        languageId: this.context.languageId || "unknown",
        seconds: (boundary - cursor) / 1000,
        characters: 0,
      });
      cursor = boundary;
    }
    if (at >= this.lastActivity + this.idleTimeoutMs) this.lastActivity = null;
  }

  setPaused(paused, now) {
    this.tick(this.timestamp(now));
    if (this.paused !== Boolean(paused)) this.lastActivity = null;
    this.paused = Boolean(paused);
  }

  configure({ idleTimeoutMs }, now) {
    const next = this.positiveNumber(idleTimeoutMs);
    this.tick(this.timestamp(now));
    this.idleTimeoutMs = next;
    if (this.lastActivity !== null && this.lastTick >= this.lastActivity + next) this.lastActivity = null;
  }

  status(now) {
    const at = this.timestamp(now);
    if (this.paused) return "paused";
    return this.canTrack() && this.lastActivity !== null && at >= this.lastTick &&
      at - this.lastTick <= this.maxGapMs && at < this.lastActivity + this.idleTimeoutMs ? "tracking" : "idle";
  }
}

module.exports = { ActiveTracker };
