import { describe, it, expect } from "vitest";
import { checkClientTime, FUTURE_SKEW_MS, MAX_PAST_MS } from "../../api/submitGuard.js";

const NOW = new Date("2026-06-02T15:00:00.000Z").getTime();

function body(overrides = {}) {
  return {
    name: "Test",
    action: "Clock In",
    timestamp: new Date(NOW).toISOString(),
    client_time: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("checkClientTime", () => {
  it("passes when client_time equals now", () => {
    const res = checkClientTime(body(), NOW);
    expect(res.ok).toBe(true);
  });

  it("passes within 5 min future skew", () => {
    const ct = new Date(NOW + 4 * 60 * 1000).toISOString();
    const res = checkClientTime(body({ client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(true);
  });

  it("rejects more than 5 min future", () => {
    const ct = new Date(NOW + 6 * 60 * 1000).toISOString();
    const res = checkClientTime(body({ client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/future/);
  });

  it("passes within 12h past (offline sync within bound)", () => {
    const ct = new Date(NOW - 11 * 3600 * 1000).toISOString();
    const res = checkClientTime(body({ client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(true);
  });

  it("rejects more than 12h past", () => {
    const ct = new Date(NOW - 13 * 3600 * 1000).toISOString();
    const res = checkClientTime(body({ client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/past/);
  });

  it("rejects unparseable client_time", () => {
    const res = checkClientTime(body({ client_time: "not-a-date", timestamp: "not-a-date" }), NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid client_time/);
  });

  it("rejects missing client_time AND timestamp", () => {
    const res = checkClientTime(body({ client_time: undefined, timestamp: undefined }), NOW);
    expect(res.ok).toBe(false);
  });

  it("falls back to body.timestamp when client_time is absent", () => {
    // Real /api/submit payload uses `timestamp` from sync.schedule.
    const ct = new Date(NOW - 60000).toISOString();
    const res = checkClientTime({ action: "Clock In", timestamp: ct }, NOW);
    expect(res.ok).toBe(true);
  });

  it("ignores bounds for Day Off action", () => {
    const ct = new Date(NOW - 30 * 24 * 3600 * 1000).toISOString(); // 30 days ago
    const res = checkClientTime(body({ action: "Day Off", client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(true);
  });

  it("ignores bounds for Paid Off action", () => {
    const ct = new Date(NOW + 10 * 24 * 3600 * 1000).toISOString(); // 10 days future
    const res = checkClientTime(body({ action: "Paid Off", client_time: ct, timestamp: ct }), NOW);
    expect(res.ok).toBe(true);
  });

  it("passes (no-op) for non-object body", () => {
    expect(checkClientTime(null, NOW).ok).toBe(true);
    expect(checkClientTime(undefined, NOW).ok).toBe(true);
  });

  it("exposes the documented bound constants", () => {
    expect(FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
    expect(MAX_PAST_MS).toBe(12 * 3600 * 1000);
  });
});
