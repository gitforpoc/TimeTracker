import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Configurable mock responses (reset in beforeEach) ---
let getUserResult;
let profileResult;
let dedupResult;
let insertedRows;

// --- Mock @supabase/supabase-js with a per-table query builder ---
const mockSupabase = {
  auth: {
    getUser: vi.fn(async () => getUserResult),
  },
  from: vi.fn((table) => {
    if (table === "profiles") {
      return {
        select: () => ({ eq: () => ({ single: async () => profileResult }) }),
      };
    }
    if (table === "tt_logs") {
      return {
        // dedup guard: select().eq().eq().limit()
        select: () => ({
          eq: () => ({ eq: () => ({ limit: async () => dedupResult }) }),
        }),
        insert: (rows) => {
          insertedRows.push(...rows);
          return Promise.resolve({ data: rows, error: null });
        },
        update: () => ({ eq: async () => ({ data: null, error: null }) }),
      };
    }
    // tt_shifts (backdate-audit lookup) — only hit when actual_tap_time present
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        }),
      }),
    };
  }),
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabase),
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
delete process.env.GOOGLE_SCRIPT_URL; // Google task skips → Supabase-only path

const { default: handler } = await import("../../api/submit.js");

function makeReq(overrides = {}) {
  const nowIso = new Date().toISOString();
  return {
    method: "POST",
    headers: { authorization: "Bearer valid-token", ...overrides.headers },
    body: {
      name: "Impostor",
      action: "Clock In",
      id: 12345,
      timestamp: nowIso,
      client_time: nowIso,
      localTime: "9:00am",
      ...overrides.body,
    },
  };
}

function makeRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    setHeader: vi.fn(),
    status: vi.fn(function (c) {
      res._status = c;
      return res;
    }),
    json: vi.fn(function (d) {
      res._json = d;
      return res;
    }),
    end: vi.fn(function () {
      res._ended = true;
      return res;
    }),
  };
  return res;
}

describe("/api/submit identity enforcement", () => {
  beforeEach(() => {
    insertedRows = [];
    getUserResult = { data: { user: { id: "u1" } }, error: null };
    profileResult = { data: { name: "RealUser" }, error: null };
    dedupResult = { data: [] };
    mockSupabase.auth.getUser.mockClear();
    mockSupabase.from.mockClear();
  });

  it("writes the event under the AUTHENTICATED user's name, ignoring body.name", async () => {
    const req = makeReq({ body: { name: "Impostor" } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].user_name).toBe("RealUser"); // NOT "Impostor"
    // The shared body is also corrected (Google Sheets mirror reads it)
    expect(req.body.name).toBe("RealUser");
  });

  it("rejects with 503 (retryable) when the profile name can't be resolved", async () => {
    profileResult = { data: null, error: null };
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(503);
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects with 401 when the token is invalid", async () => {
    getUserResult = { data: { user: null }, error: { message: "bad" } };
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(401);
    expect(insertedRows).toHaveLength(0);
  });

  it("401 when no Bearer token is present", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "" } }), res);
    expect(res._status).toBe(401);
  });
});
