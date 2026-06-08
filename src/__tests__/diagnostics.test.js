import { describe, it, expect } from "vitest";
import {
  decodeJwtExp,
  buildQueueSection,
  computeClockSkewSec,
  formatReportText,
} from "../diagnostics.js";

function makeToken(expSec) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `header.${payload}.sig`;
}

describe("decodeJwtExp", () => {
  it("decodes a valid exp claim to epoch ms", () => {
    const exp = 1_900_000_000; // seconds
    expect(decodeJwtExp(makeToken(exp))).toBe(exp * 1000);
  });

  it("returns null for non-string / malformed / missing exp", () => {
    expect(decodeJwtExp(null)).toBeNull();
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
    expect(decodeJwtExp("a.b")).toBeNull();
    const noExp = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(decodeJwtExp(`h.${noExp}.s`)).toBeNull();
  });
});

describe("buildQueueSection", () => {
  const now = 1_000_000_000_000;

  it("reports an empty queue", () => {
    const s = buildQueueSection({ queue: [], failedCount: 0 }, now);
    expect(s.pending).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.head).toBeNull();
    expect(s.oldestPendingAgeMin).toBe(0);
  });

  it("flags a head item older than 12h", () => {
    const thirteenHAgo = new Date(now - 13 * 3600 * 1000).toISOString();
    const s = buildQueueSection(
      {
        queue: [
          {
            payload: { action: "Clock In", timestamp: thirteenHAgo },
            enqueued_at: now - 13 * 3600 * 1000,
          },
        ],
        failedCount: 2,
        authBroken: true,
        tokenGetterWired: false,
      },
      now
    );
    expect(s.pending).toBe(1);
    expect(s.failed).toBe(2);
    expect(s.authBroken).toBe(true);
    expect(s.tokenGetterWired).toBe(false);
    expect(s.head.action).toBe("Clock In");
    expect(s.head.olderThan12h).toBe(true);
    expect(s.head.ageMin).toBe(13 * 60);
    expect(s.oldestPendingAgeMin).toBe(13 * 60);
  });

  it("does not flag a fresh head item", () => {
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const s = buildQueueSection(
      { queue: [{ payload: { action: "Clock Out", timestamp: tenMinAgo }, enqueued_at: now - 10 * 60 * 1000 }], failedCount: 0 },
      now
    );
    expect(s.head.olderThan12h).toBe(false);
    expect(s.head.ageMin).toBe(10);
  });
});

describe("computeClockSkewSec", () => {
  it("returns ~0 when client and server agree (no rtt)", () => {
    expect(computeClockSkewSec(1000, 1000, 0)).toBe(0);
  });

  it("detects a device clock ahead of server", () => {
    // device says 60s later than server, instant rtt
    expect(computeClockSkewSec(60_000, 0, 0)).toBe(60);
  });

  it("corrects for round-trip (half added to client send time)", () => {
    // client sent at 0, server stamped 0, rtt 2000 → device ~+1s at stamp moment
    expect(computeClockSkewSec(0, 0, 2000)).toBe(1);
  });

  it("returns null for non-finite inputs", () => {
    expect(computeClockSkewSec(NaN, 1000, 0)).toBeNull();
    expect(computeClockSkewSec(1000, NaN, 0)).toBeNull();
  });
});

describe("formatReportText", () => {
  it("includes the key diagnostic fields", () => {
    const text = formatReportText({
      userName: "Jairo",
      clientTime: "2026-06-07T12:00:00.000Z",
      tokenValidServer: false,
      auth: { hasSession: true, tokenPresent: true, tokenExpired: true, refreshTest: "failed" },
      queue: { pending: 3, failed: 1, oldestPendingAgeMin: 800, authBroken: true, head: { action: "Clock In", timestamp: "x", ageMin: 800, olderThan12h: true } },
      connectivity: { diagPostStatus: 200, roundTripMs: 120, clockSkewSec: 5 },
      device: { online: true, standalone: false, tz: "America/New_York", ua: "Mozilla/5.0" },
    });
    expect(text).toContain("Jairo");
    expect(text).toContain("tokenValid(server): false");
    expect(text).toContain("refreshTest: failed");
    expect(text).toContain("pending: 3 | failed: 1");
    expect(text).toContain(">12h true");
    expect(text).toContain("diagPost: 200");
  });
});
