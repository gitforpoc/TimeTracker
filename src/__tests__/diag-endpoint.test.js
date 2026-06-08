import { describe, it, expect } from "vitest";
import handler from "../../api/diag.js";

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
