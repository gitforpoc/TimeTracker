import { describe, it, expect } from "vitest";
import handler, { serverClockSkewSec, clientIp, checkRateLimit } from "../../api/diag.js";

function mockRes() {
  return {
    statusCode: null,
    body: null,
    ended: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

const validReport = { app: "timetracker", userName: "Test", device: { ua: "x" } };

describe("/api/diag guard branches", () => {
  it("answers OPTIONS preflight with 200", async () => {
    const res = mockRes();
    await handler({ method: "OPTIONS", headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });

  it("rejects non-POST with 405", async () => {
    const res = mockRes();
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("400 when body is missing", async () => {
    const res = mockRes();
    await handler({ method: "POST", headers: {}, body: undefined }, res);
    expect(res.statusCode).toBe(400);
  });

  it("400 when report object is missing", async () => {
    const res = mockRes();
    await handler({ method: "POST", headers: {}, body: { foo: 1 } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("400 when app marker is wrong (anti-junk)", async () => {
    const res = mockRes();
    await handler(
      { method: "POST", headers: {}, body: { report: { app: "somethingelse" } } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Unknown app/);
  });

  it("413 when the report exceeds the size cap", async () => {
    const res = mockRes();
    const big = { app: "timetracker", blob: "x".repeat(40 * 1024) };
    await handler({ method: "POST", headers: {}, body: { report: big } }, res);
    expect(res.statusCode).toBe(413);
  });

  it("computes clock skew: 0 when client == server", () => {
    const now = 1_700_000_000_000;
    expect(serverClockSkewSec(new Date(now).toISOString(), now)).toBe(0);
  });

  it("computes clock skew: positive when device clock is ahead", () => {
    const now = 1_700_000_000_000;
    const clientAhead = new Date(now + 90_000).toISOString(); // device +90s
    expect(serverClockSkewSec(clientAhead, now)).toBe(90);
  });

  it("computes clock skew: negative when device clock is behind", () => {
    const now = 1_700_000_000_000;
    const clientBehind = new Date(now - 3600_000).toISOString(); // device -1h
    expect(serverClockSkewSec(clientBehind, now)).toBe(-3600);
  });

  it("clock skew is null for unparseable/missing client time", () => {
    expect(serverClockSkewSec(undefined, 1_700_000_000_000)).toBeNull();
    expect(serverClockSkewSec("not-a-date", 1_700_000_000_000)).toBeNull();
  });

  it("clientIp reads first hop of x-forwarded-for, falls back to socket", () => {
    expect(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })).toBe("1.2.3.4");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "9.9.9.9" } })).toBe("9.9.9.9");
    expect(clientIp({ headers: {} })).toBeNull();
  });

  it("rate limit: allows up to the cap, then blocks the same IP", () => {
    const hits = new Map();
    const now = 1_700_000_000_000;
    // 10 allowed (max=10, blocks only when count EXCEEDS max)
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(hits, "1.1.1.1", now, 60_000, 10)).toBe(false);
    }
    expect(checkRateLimit(hits, "1.1.1.1", now, 60_000, 10)).toBe(true); // 11th
  });

  it("rate limit: window slides — old hits expire", () => {
    const hits = new Map();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 11; i++) checkRateLimit(hits, "2.2.2.2", t0, 60_000, 10);
    // Far in the future, prior hits are outside the window → allowed again
    expect(checkRateLimit(hits, "2.2.2.2", t0 + 120_000, 60_000, 10)).toBe(false);
  });

  it("rate limit: null IP is never limited; per-IP isolation", () => {
    const hits = new Map();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit(hits, null, now, 60_000, 10)).toBe(false);
    }
    // One IP over the cap does not affect a different IP
    for (let i = 0; i < 11; i++) checkRateLimit(hits, "a", now, 60_000, 10);
    expect(checkRateLimit(hits, "b", now, 60_000, 10)).toBe(false);
  });

  it("returns 429 when the same IP floods the endpoint", async () => {
    let last;
    for (let i = 0; i < 12; i++) {
      last = mockRes();
      await handler(
        {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.9" },
          body: { report: validReport },
        },
        last
      );
    }
    expect(last.statusCode).toBe(429);
  });

  it("passes all guards on a valid report (then 500: no backend in unit env)", async () => {
    // Proves a well-formed report clears every guard. Without SUPABASE_* env in
    // the unit environment it stops at the storage-config check (500), which is
    // exactly the branch right after the guards.
    const res = mockRes();
    await handler({ method: "POST", headers: {}, body: { report: validReport } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
