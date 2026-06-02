import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock browser globals before importing editDrafts.js (which imports
// store.js → touches localStorage at module top, and utils.js → showToast
// touches the DOM). Mirror the pattern from history-quota.test.js +
// sync.test.js.
const storage = {};
vi.stubGlobal("localStorage", {
  getItem: (key) => storage[key] ?? null,
  setItem: (key, val) => { storage[key] = String(val); },
  removeItem: (key) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
});
vi.stubGlobal("location", { hostname: "localhost", href: "http://localhost/" });

// `showToast` walks document.getElementById("toast"); just stub a no-op DOM.
vi.stubGlobal("document", {
  cookie: "",
  addEventListener: () => {},
  getElementById: () => ({
    innerText: "",
    classList: { add: () => {}, remove: () => {} },
  }),
});
vi.stubGlobal("window", { addEventListener: () => {} });

const { store } = await import("../store.js");
const {
  loadDrafts,
  saveDraft,
  removeDraft,
  daysOldOf,
  expireOldDrafts,
  evaluateDraftApplicability,
} = await import("../editDrafts.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 10, 12, 0, 0); // 2026-06-10 12:00 UTC

function isoAgo(daysAgo) {
  return new Date(NOW - daysAgo * DAY_MS).toISOString();
}

function mkDraft(shiftId, daysAgo = 0, extra = {}) {
  return {
    shift_id: String(shiftId),
    snapshot: {
      clock_in: "2026-06-01T13:00:00.000Z",
      clock_out: "2026-06-01T21:00:00.000Z",
      type: "work",
      comment: null,
      latest_edit_at: null,
    },
    proposed_changes: { clock_in: "2026-06-01T12:55:00.000Z" },
    reason: "Forgot to clock in",
    created_at: isoAgo(daysAgo),
    user_name: "Yuri",
    ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  store.userName = "Yuri";
});

describe("daysOldOf", () => {
  it("returns 0 for created_at == now", () => {
    const d = mkDraft(1, 0);
    expect(daysOldOf(d, NOW)).toBe(0);
  });

  it("returns ~4.9 for 4.9 day-old draft", () => {
    const d = { created_at: new Date(NOW - 4.9 * DAY_MS).toISOString() };
    expect(daysOldOf(d, NOW)).toBeCloseTo(4.9, 5);
  });

  it("returns exactly 5 for 5 day-old draft", () => {
    const d = { created_at: new Date(NOW - 5 * DAY_MS).toISOString() };
    expect(daysOldOf(d, NOW)).toBeCloseTo(5, 5);
  });

  it("returns 6.5 for 6.5 day-old draft", () => {
    const d = { created_at: new Date(NOW - 6.5 * DAY_MS).toISOString() };
    expect(daysOldOf(d, NOW)).toBeCloseTo(6.5, 5);
  });

  it("returns 7 for 7 day-old draft", () => {
    const d = { created_at: new Date(NOW - 7 * DAY_MS).toISOString() };
    expect(daysOldOf(d, NOW)).toBeCloseTo(7, 5);
  });

  it("returns 8 for 8 day-old draft", () => {
    const d = { created_at: new Date(NOW - 8 * DAY_MS).toISOString() };
    expect(daysOldOf(d, NOW)).toBeCloseTo(8, 5);
  });

  it("returns 0 for missing or malformed created_at", () => {
    expect(daysOldOf({}, NOW)).toBe(0);
    expect(daysOldOf({ created_at: "garbage" }, NOW)).toBe(0);
    expect(daysOldOf(null, NOW)).toBe(0);
  });
});

describe("expireOldDrafts", () => {
  it("partitions mixed drafts and persists trimmed list", () => {
    saveDraft(mkDraft(1, 0));      // fresh
    saveDraft(mkDraft(2, 4));      // fresh
    saveDraft(mkDraft(3, 5.5));    // expiring-soon
    saveDraft(mkDraft(4, 6.9));    // expiring-soon
    saveDraft(mkDraft(5, 7));      // expired (boundary)
    saveDraft(mkDraft(6, 9));      // expired

    const { removed, expiringSoon } = expireOldDrafts(NOW);
    expect(removed.map((d) => d.shift_id).sort()).toEqual(["5", "6"]);
    expect(expiringSoon.map((d) => d.shift_id).sort()).toEqual(["3", "4"]);

    // Storage should now contain only the 4 kept drafts.
    const remaining = loadDrafts();
    expect(remaining.map((d) => d.shift_id).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("no-op when nothing is expired", () => {
    saveDraft(mkDraft(1, 0));
    saveDraft(mkDraft(2, 3));
    const { removed, expiringSoon } = expireOldDrafts(NOW);
    expect(removed).toEqual([]);
    expect(expiringSoon).toEqual([]);
    expect(loadDrafts()).toHaveLength(2);
  });

  it("safe when storage is empty", () => {
    const { removed, expiringSoon } = expireOldDrafts(NOW);
    expect(removed).toEqual([]);
    expect(expiringSoon).toEqual([]);
  });
});

describe("saveDraft / loadDrafts / removeDraft round-trip", () => {
  it("round-trips a single draft via localStorage", () => {
    const d = mkDraft(42, 1);
    saveDraft(d);
    const loaded = loadDrafts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].shift_id).toBe("42");
    expect(loaded[0].reason).toBe("Forgot to clock in");
    expect(loaded[0].proposed_changes.clock_in).toBe("2026-06-01T12:55:00.000Z");
  });

  it("removeDraft pulls one entry and leaves others", () => {
    saveDraft(mkDraft(1, 0));
    saveDraft(mkDraft(2, 0));
    removeDraft("1");
    const left = loadDrafts();
    expect(left.map((d) => d.shift_id)).toEqual(["2"]);
  });

  it("removeDraft is a no-op when shift_id is unknown", () => {
    saveDraft(mkDraft(1, 0));
    removeDraft("999");
    expect(loadDrafts()).toHaveLength(1);
  });
});

describe("saveDraft replaces same shift_id", () => {
  it("only one draft remains for the same shift_id; latest wins", () => {
    saveDraft(mkDraft(1, 2, { reason: "Old reason" }));
    saveDraft(mkDraft(1, 0, { reason: "New reason" }));
    const all = loadDrafts();
    expect(all).toHaveLength(1);
    expect(all[0].reason).toBe("New reason");
  });
});

describe("loadDrafts filters by current user_name", () => {
  it("hides drafts owned by a different user", () => {
    saveDraft({ ...mkDraft(1, 0), user_name: "Yuri" });
    saveDraft({ ...mkDraft(2, 0), user_name: "Alice" });
    store.userName = "Yuri";
    const mine = loadDrafts();
    expect(mine.map((d) => d.shift_id)).toEqual(["1"]);
  });

  it("returns all drafts when store.userName is empty (guest mode)", () => {
    saveDraft({ ...mkDraft(1, 0), user_name: "Yuri" });
    saveDraft({ ...mkDraft(2, 0), user_name: "Alice" });
    store.userName = "";
    expect(loadDrafts()).toHaveLength(2);
  });

  it("legacy drafts without user_name are visible to any user", () => {
    // Save a draft then strip user_name from storage to simulate legacy.
    saveDraft(mkDraft(1, 0));
    const raw = JSON.parse(localStorage.getItem("tt_edit_drafts"));
    raw[0].user_name = null;
    localStorage.setItem("tt_edit_drafts", JSON.stringify(raw));

    store.userName = "Other";
    expect(loadDrafts()).toHaveLength(1);
  });
});

describe("evaluateDraftApplicability", () => {
  const ME = "user-me";
  const SUP = "user-supervisor";

  function freshDraft(overrides = {}) {
    return mkDraft(100, 1, {
      snapshot: {
        clock_in: "2026-06-01T13:00:00.000Z",
        clock_out: "2026-06-01T21:00:00.000Z",
        type: "work",
        comment: null,
        latest_edit_at: "2026-06-01T22:00:00.000Z",
      },
      proposed_changes: { clock_in: "2026-06-01T12:55:00.000Z" },
      ...overrides,
    });
  }

  const cleanState = {
    clock_in: "2026-06-01T13:00:00.000Z",
    clock_out: "2026-06-01T21:00:00.000Z",
    type: "work",
    comment: null,
  };

  it("returns apply for a clean shift with no new edits", () => {
    const d = freshDraft();
    const result = evaluateDraftApplicability(d, cleanState, [], ME);
    expect(result.action).toBe("apply");
  });

  it("discards with supervisor reason when another user edited since snapshot", () => {
    const d = freshDraft();
    const edits = [
      {
        shift_id: "100",
        edited_by: SUP,
        edited_by_name: "Pavel",
        field_changed: "clock_in",
        reason: "Manual fix",
        created_at: "2026-06-01T23:00:00.000Z",
      },
    ];
    const result = evaluateDraftApplicability(d, cleanState, edits, ME);
    expect(result.action).toBe("discard");
    expect(result.reason).toBe("supervisor");
    expect(result.message).toMatch(/supervisor/i);
  });

  it("ignores supervisor's pre-snapshot edits (they were already part of the baseline)", () => {
    const d = freshDraft();
    const edits = [
      {
        shift_id: "100",
        edited_by: SUP,
        field_changed: "clock_in",
        reason: "Manual fix",
        // Before the snapshot's latest_edit_at — this edit was reflected in the snapshot already.
        created_at: "2026-06-01T21:30:00.000Z",
      },
    ];
    // The snapshot's `latest_edit_at` is 22:00 — but that edit was by SUP at 21:30,
    // which is < snapshot. Apply path checks "any other-user edit newer than snapshot."
    // Since this edit is older, it shouldn't block. (The supervisor-edited shift would
    // have been gated at the UI level via `adjustedShiftIds` before the user even saved
    // the draft, but we're defensive on Apply too.)
    const result = evaluateDraftApplicability(d, cleanState, edits, ME);
    expect(result.action).toBe("apply");
  });

  it("discards with quota reason when self already used the proposed field after snapshot", () => {
    const d = freshDraft();
    const edits = [
      {
        shift_id: "100",
        edited_by: ME,
        field_changed: "clock_in",
        reason: "Forgot to clock in",
        created_at: "2026-06-01T23:30:00.000Z",
      },
    ];
    const result = evaluateDraftApplicability(d, cleanState, edits, ME);
    expect(result.action).toBe("discard");
    expect(result.reason).toBe("quota");
  });

  it("does NOT count backdate-annotation rows toward quota", () => {
    const d = freshDraft();
    const edits = [
      {
        shift_id: "100",
        edited_by: ME,
        field_changed: "clock_in",
        reason: "Backdated at clock-in",
        created_at: "2026-06-02T00:00:00.000Z",
      },
    ];
    const result = evaluateDraftApplicability(d, cleanState, edits, ME);
    expect(result.action).toBe("apply");
  });

  it("discards with validation reason when proposed change yields negative duration", () => {
    // Admin moved clock_out to 12:00 — user's proposed clock_in 12:55 would be after.
    const d = freshDraft({
      proposed_changes: { clock_in: "2026-06-01T12:55:00.000Z" },
    });
    const adminMoved = {
      ...cleanState,
      clock_out: "2026-06-01T12:00:00.000Z",
    };
    const result = evaluateDraftApplicability(d, adminMoved, [], ME);
    expect(result.action).toBe("discard");
    expect(result.reason).toBe("validation");
  });

  it("discards with not-found reason when the shift no longer exists", () => {
    const d = freshDraft();
    const result = evaluateDraftApplicability(d, null, [], ME);
    expect(result.action).toBe("discard");
    expect(result.reason).toBe("not-found");
  });

  it("handles empty draft defensively (validation discard)", () => {
    const result = evaluateDraftApplicability(null, cleanState, [], ME);
    expect(result.action).toBe("discard");
  });

  it("handles non-array currentEdits defensively (treats as empty)", () => {
    const d = freshDraft();
    const result = evaluateDraftApplicability(d, cleanState, null, ME);
    expect(result.action).toBe("apply");
  });
});
