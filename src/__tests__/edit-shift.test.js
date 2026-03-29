import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mock @supabase/supabase-js ---
const mockSingle = vi.fn();
const mockEq = vi.fn(() => ({ single: mockSingle, eq: mockEq }));
const mockSelect = vi.fn(() => ({ eq: mockEq, single: mockSingle }));
const mockInsert = vi.fn(() => ({ error: null }));
const mockUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ error: null })) }));

const mockSupabase = {
  auth: {
    getUser: vi.fn(),
  },
  from: vi.fn(() => ({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  })),
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabase),
}));

// Set env vars before importing handler
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: handler } = await import("../../api/edit-shift.js");

// --- Test helpers ---
function makeReq(overrides = {}) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer valid-token",
      ...overrides.headers,
    },
    body: {
      shiftId: 1,
      changes: { comment: "updated" },
      reason: "test",
      ...overrides.body,
    },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _json: null,
    _ended: false,
    setHeader: vi.fn(),
    status: vi.fn(function (code) {
      res._status = code;
      return res;
    }),
    json: vi.fn(function (data) {
      res._json = data;
      return res;
    }),
    end: vi.fn(function () {
      res._ended = true;
      return res;
    }),
  };
  return res;
}

// Mock user data
const mockUser = { id: "user-123", email: "test@test.com" };
const mockShift = {
  id: 1,
  user_name: "Test User",
  clock_in: "2026-03-14T08:00:00.000Z",
  clock_out: "2026-03-14T16:00:00.000Z",
  duration_minutes: 480,
  type: "work",
  comment: null,
};

function setupMocks({ isAdmin = true, shiftData = mockShift, shiftError = null, authError = null, user = mockUser } = {}) {
  mockSupabase.auth.getUser.mockResolvedValue({
    data: { user: authError ? null : user },
    error: authError,
  });

  // We need to carefully mock the chained calls for from().select().eq().eq().single()
  // The handler calls Promise.all with two from() queries (user_access and profiles),
  // then a third from() query (tt_shifts).
  let fromCallCount = 0;

  mockSupabase.from.mockImplementation((table) => {
    if (table === "user_access") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({
                data: isAdmin ? { role: "admin" } : { role: "user" },
                error: null,
              })),
            })),
          })),
        })),
      };
    }
    if (table === "profiles") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => ({
              data: { name: user?.email === "admin@test.com" ? "Admin" : "Test User" },
              error: null,
            })),
          })),
        })),
      };
    }
    if (table === "tt_shifts") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => ({
              data: shiftError ? null : shiftData,
              error: shiftError,
            })),
          })),
        })),
        update: vi.fn(() => ({
          eq: vi.fn(() => ({ error: null })),
        })),
      };
    }
    if (table === "tt_edits") {
      return {
        insert: vi.fn(() => ({ error: null })),
      };
    }
    return {
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => ({ data: null, error: null })) })) })),
      update: vi.fn(() => ({ eq: vi.fn(() => ({ error: null })) })),
      insert: vi.fn(() => ({ error: null })),
    };
  });
}

describe("edit-shift API handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 for OPTIONS (CORS preflight)", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._ended).toBe(true);
  });

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json.error).toBe("POST only");
  });

  it("returns 401 without auth header", async () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Authentication required");
  });

  it("returns 401 with malformed auth header", async () => {
    const req = makeReq({ headers: { authorization: "Basic abc" } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Authentication required");
  });

  it("returns 401 with invalid token", async () => {
    setupMocks({ authError: new Error("invalid token") });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe("Invalid session");
  });

  it("returns 400 when shiftId is missing", async () => {
    setupMocks();
    const req = makeReq({ body: { changes: { comment: "x" } } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("shiftId and changes required");
  });

  it("returns 400 when changes is missing", async () => {
    setupMocks();
    const req = makeReq({ body: { shiftId: 1 } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("shiftId and changes required");
  });

  it("returns 404 when shift not found (before permission check)", async () => {
    setupMocks({ shiftError: { message: "not found" } });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(404);
    expect(res._json.error).toBe("Shift not found");
  });

  it("returns 403 when non-admin edits someone else's shift", async () => {
    setupMocks({
      isAdmin: false,
      shiftData: { ...mockShift, user_name: "Other Person" },
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(403);
    expect(res._json.error).toBe("You can only edit your own shifts");
  });

  it("allows non-admin to edit own shift", async () => {
    setupMocks({
      isAdmin: false,
      shiftData: { ...mockShift, user_name: "Test User" },
    });
    const req = makeReq({
      body: { shiftId: 1, changes: { comment: "new comment" }, reason: "fix" },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.edits).toBe(1);
  });

  it("allows admin to edit any shift", async () => {
    setupMocks({
      isAdmin: true,
      shiftData: { ...mockShift, user_name: "Someone Else" },
    });
    const req = makeReq({
      body: { shiftId: 1, changes: { comment: "admin fix" }, reason: "correction" },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.edits).toBe(1);
  });

  it("returns 400 when clock_out < clock_in (negative duration)", async () => {
    setupMocks({
      isAdmin: true,
      shiftData: { ...mockShift },
    });
    const req = makeReq({
      body: {
        shiftId: 1,
        changes: {
          clock_in: "2026-03-14T16:00:00.000Z",
          clock_out: "2026-03-14T08:00:00.000Z",
        },
        reason: "typo",
      },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Clock Out must be after Clock In");
  });

  it("returns 200 with no changes detected", async () => {
    setupMocks({
      isAdmin: true,
      shiftData: { ...mockShift, comment: "same" },
    });
    const req = makeReq({
      body: { shiftId: 1, changes: { comment: "same" }, reason: "test" },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.message).toBe("No changes detected");
  });

  it("successfully updates shift and creates audit records", async () => {
    const updateEq = vi.fn(() => ({ error: null }));
    const insertFn = vi.fn(() => ({ error: null }));

    mockSupabase.from.mockImplementation((table) => {
      if (table === "user_access") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => ({ data: { role: "admin" }, error: null })),
              })),
            })),
          })),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({ data: { name: "Admin" }, error: null })),
            })),
          })),
        };
      }
      if (table === "tt_shifts") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({ data: { ...mockShift }, error: null })),
            })),
          })),
          update: vi.fn(() => ({ eq: updateEq })),
        };
      }
      if (table === "tt_edits") {
        return { insert: insertFn };
      }
      return {};
    });

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: mockUser },
      error: null,
    });

    const req = makeReq({
      body: {
        shiftId: 1,
        changes: { comment: "updated comment", type: "day_off" },
        reason: "correction",
      },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json.edits).toBe(2); // comment + type changed
    expect(res._json.message).toBe("Updated 2 field(s)");

    // Verify audit records were inserted
    expect(insertFn).toHaveBeenCalledOnce();
    const auditRecords = insertFn.mock.calls[0][0];
    expect(auditRecords).toHaveLength(2);
    expect(auditRecords[0].field_changed).toBe("type");
    expect(auditRecords[1].field_changed).toBe("comment");
  });

  it("recalculates duration when clock times change", async () => {
    const updateEq = vi.fn(() => ({ error: null }));
    let updatePayload = null;

    mockSupabase.from.mockImplementation((table) => {
      if (table === "user_access") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => ({ data: { role: "admin" }, error: null })),
              })),
            })),
          })),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({ data: { name: "Admin" }, error: null })),
            })),
          })),
        };
      }
      if (table === "tt_shifts") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => ({ data: { ...mockShift }, error: null })),
            })),
          })),
          update: vi.fn((payload) => {
            updatePayload = payload;
            return { eq: updateEq };
          }),
        };
      }
      if (table === "tt_edits") {
        return { insert: vi.fn(() => ({ error: null })) };
      }
      return {};
    });

    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: mockUser },
      error: null,
    });

    const req = makeReq({
      body: {
        shiftId: 1,
        changes: {
          clock_in: "2026-03-14T09:00:00.000Z", // was 08:00
        },
        reason: "fix",
      },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Duration should be recalculated: 16:00 - 09:00 = 7h = 420min
    expect(updatePayload).toBeDefined();
    expect(updatePayload.duration_minutes).toBe(420);
  });
});
