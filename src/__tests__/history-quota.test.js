import { describe, it, expect, vi } from "vitest";

// Mock browser globals before importing history.js (which transitively imports
// store.js / sync.js — both touch localStorage at module top — and auth.js
// which reads location.hostname at module top).
//
// IMPORTANT for migration tests: history.js runs `loadEditedFields()` once at
// module-import time. The migration test below relies on `tt_edited_shifts`
// being present in storage BEFORE that import — which is why we pre-populate
// the storage object here, before the dynamic import.
const storage = {};
storage["tt_edited_shifts"] = JSON.stringify([123]); // legacy key for migration test
vi.stubGlobal("localStorage", {
  getItem: (key) => storage[key] ?? null,
  setItem: (key, val) => { storage[key] = String(val); },
  removeItem: (key) => { delete storage[key]; },
  clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
});
vi.stubGlobal("location", { hostname: "localhost", href: "http://localhost/" });
vi.stubGlobal("document", { cookie: "", addEventListener: () => {} });
vi.stubGlobal("window", { addEventListener: () => {} });

const { classifyEdits, buildEditedFieldsMap, formatEditHistoryRow } = await import("../history.js");

describe("classifyEdits", () => {
  const ME = "user-me";
  const SUP = "user-supervisor";

  it("returns empty sets for empty input", () => {
    const { editedByMe, adjustedByOthers } = classifyEdits([], ME);
    expect(editedByMe.size).toBe(0);
    expect(adjustedByOthers.size).toBe(0);
  });

  it("returns empty sets for non-array input", () => {
    const { editedByMe, adjustedByOthers } = classifyEdits(null, ME);
    expect(editedByMe.size).toBe(0);
    expect(adjustedByOthers.size).toBe(0);
  });

  it("counts a user's own real edit toward editedByMe", () => {
    const edits = [{ shift_id: 1, edited_by: ME, reason: "Forgot to clock out" }];
    const { editedByMe, adjustedByOthers } = classifyEdits(edits, ME);
    expect(editedByMe.has(1)).toBe(true);
    expect(adjustedByOthers.size).toBe(0);
  });

  it("counts supervisor edit toward adjustedByOthers", () => {
    const edits = [{ shift_id: 2, edited_by: SUP, reason: "Manual fix" }];
    const { editedByMe, adjustedByOthers } = classifyEdits(edits, ME);
    expect(editedByMe.size).toBe(0);
    expect(adjustedByOthers.has(2)).toBe(true);
  });

  it("SKIPS 'Backdated at clock-in' rows even though edited_by is me", () => {
    // The crucial 1b-extra invariant: backdate annotations must NOT consume
    // edit quota.
    const edits = [
      { shift_id: 3, edited_by: ME, reason: "Backdated at clock-in" },
    ];
    const { editedByMe, adjustedByOthers } = classifyEdits(edits, ME);
    expect(editedByMe.has(3)).toBe(false);
    expect(adjustedByOthers.has(3)).toBe(false);
  });

  it("SKIPS 'Backdated at clock-out' rows similarly", () => {
    const edits = [
      { shift_id: 4, edited_by: ME, reason: "Backdated at clock-out" },
    ];
    const { editedByMe } = classifyEdits(edits, ME);
    expect(editedByMe.has(4)).toBe(false);
  });

  it("does NOT classify backdate rows as supervisor adjustment either", () => {
    // Even if (unusual case) some other user wrote the backdate row,
    // it still shouldn't lock the shift.
    const edits = [
      { shift_id: 5, edited_by: SUP, reason: "Backdated at clock-in" },
    ];
    const { adjustedByOthers } = classifyEdits(edits, ME);
    expect(adjustedByOthers.has(5)).toBe(false);
  });

  it("mixed: real edit + backdate on same shift counts only the real edit", () => {
    const edits = [
      { shift_id: 6, edited_by: ME, reason: "Backdated at clock-in" },
      { shift_id: 6, edited_by: ME, reason: "Forgot to clock out" },
    ];
    const { editedByMe } = classifyEdits(edits, ME);
    expect(editedByMe.has(6)).toBe(true);
  });

  it("ignores null/undefined entries gracefully", () => {
    const edits = [
      null,
      undefined,
      { shift_id: 7, edited_by: ME, reason: "Forgot to clock out" },
    ];
    const { editedByMe } = classifyEdits(edits, ME);
    expect(editedByMe.has(7)).toBe(true);
  });

  it("treats missing reason as a real edit (back-compat with old rows)", () => {
    // Old tt_edits rows from before the backdate feature had no reason or
    // a different reason — those are real corrections, not annotations.
    const edits = [{ shift_id: 8, edited_by: ME, reason: null }];
    const { editedByMe } = classifyEdits(edits, ME);
    expect(editedByMe.has(8)).toBe(true);
  });

  it("returns per-field map alongside editedByMe (new shape)", () => {
    // The classify helper now also returns `fieldsByShift` so the UI can do
    // per-field gating instead of per-shift lockout.
    const edits = [
      { shift_id: 9, edited_by: ME, field_changed: "clock_in", reason: "Forgot to clock in" },
      { shift_id: 9, edited_by: ME, field_changed: "comment", reason: "Cleanup" },
      { shift_id: 9, edited_by: ME, field_changed: "clock_in", reason: "Backdated at clock-in" }, // skipped
    ];
    const { editedByMe, fieldsByShift } = classifyEdits(edits, ME);
    expect(editedByMe.has(9)).toBe(true);
    const fields = fieldsByShift.get("9");
    expect(fields).toBeTruthy();
    expect(fields.has("clock_in")).toBe(true);
    expect(fields.has("comment")).toBe(true);
    expect(fields.has("clock_out")).toBe(false);
    expect(fields.has("type")).toBe(false);
  });

  it("does NOT include backdate rows in fieldsByShift even if they have field_changed", () => {
    const edits = [
      { shift_id: 10, edited_by: ME, field_changed: "clock_in", reason: "Backdated at clock-in" },
    ];
    const { fieldsByShift } = classifyEdits(edits, ME);
    expect(fieldsByShift.has("10")).toBe(false);
  });

  it("does NOT include other users' edits in fieldsByShift", () => {
    const edits = [
      { shift_id: 11, edited_by: SUP, field_changed: "clock_in", reason: "Manual fix" },
    ];
    const { fieldsByShift } = classifyEdits(edits, ME);
    expect(fieldsByShift.has("11")).toBe(false);
  });
});

describe("buildEditedFieldsMap", () => {
  const ME = "user-me";
  const SUP = "user-supervisor";

  it("returns empty map for empty input", () => {
    const m = buildEditedFieldsMap([], ME);
    expect(m.size).toBe(0);
  });

  it("accumulates fields per shift for the current user", () => {
    const edits = [
      { shift_id: 1, edited_by: ME, field_changed: "clock_in", reason: "Forgot to clock in" },
      { shift_id: 1, edited_by: ME, field_changed: "comment", reason: "Cleanup" },
      { shift_id: 2, edited_by: ME, field_changed: "type", reason: "Wrong type" },
    ];
    const m = buildEditedFieldsMap(edits, ME);
    expect([...m.get("1")]).toEqual(expect.arrayContaining(["clock_in", "comment"]));
    expect([...m.get("2")]).toEqual(["type"]);
  });

  it("skips supervisor edits entirely", () => {
    const edits = [
      { shift_id: 1, edited_by: SUP, field_changed: "clock_in", reason: "Manual fix" },
    ];
    const m = buildEditedFieldsMap(edits, ME);
    expect(m.size).toBe(0);
  });

  it("skips backdate annotations", () => {
    const edits = [
      { shift_id: 1, edited_by: ME, field_changed: "clock_in", reason: "Backdated at clock-in" },
    ];
    const m = buildEditedFieldsMap(edits, ME);
    expect(m.size).toBe(0);
  });
});

describe("legacy tt_edited_shifts migration", () => {
  it("migrated the seeded legacy key into tt_edited_fields with all 4 fields", () => {
    // We pre-seeded `tt_edited_shifts = [123]` at the very top of this test
    // file, BEFORE the dynamic import of history.js. That import ran
    // loadEditedFields() once and performed the migration. We assert here
    // that the new key now exists with all 4 fields marked consumed, and
    // the old key was deleted.
    const newRaw = storage["tt_edited_fields"];
    expect(newRaw).toBeTruthy();
    const obj = JSON.parse(newRaw);
    expect(obj["123"]).toEqual(
      expect.arrayContaining(["clock_in", "clock_out", "type", "comment"])
    );
    expect(obj["123"].length).toBe(4);
    expect(storage["tt_edited_shifts"]).toBeUndefined();
  });
});

describe("formatEditHistoryRow", () => {
  it("renders a standard clock_in edit naturally", () => {
    const row = formatEditHistoryRow({
      shift_id: 1,
      field_changed: "clock_in",
      old_value: "2026-06-02T13:19:01-04:00",
      new_value: "2026-06-02T13:03:00-04:00",
      edited_by_name: "Yuri",
      reason: "Forgot to clock in",
      created_at: "2026-06-02T23:30:00-04:00",
    });
    expect(row).toContain("clock_in");
    expect(row).toContain("Yuri");
    expect(row).toContain("Forgot to clock in");
  });

  it("formats backdate rows naturally as 'Originally tapped at ... recorded as ...'", () => {
    const row = formatEditHistoryRow({
      shift_id: 1,
      field_changed: "clock_in",
      old_value: "2026-06-02T13:19:01-04:00", // actual tap
      new_value: "2026-06-02T13:02:00-04:00", // backdated recorded
      edited_by_name: "system",
      reason: "Backdated at clock-in",
      created_at: "2026-06-02T13:19:02-04:00",
    });
    expect(row).toMatch(/Originally tapped at/);
    expect(row).toMatch(/recorded as/);
    expect(row).toMatch(/Backdated/);
  });

  it("returns empty string for null input", () => {
    expect(formatEditHistoryRow(null)).toBe("");
  });

  it("handles missing optional fields gracefully", () => {
    const row = formatEditHistoryRow({
      shift_id: 1,
      field_changed: "comment",
      old_value: null,
      new_value: "new comment",
      created_at: "2026-06-02T13:19:02-04:00",
    });
    expect(row).toContain("comment");
    expect(row).toContain("Unknown"); // edited_by_name fallback
  });
});

describe("manually-added shift sentinel", () => {
  const ME = "user-me";
  const SUP = "user-supervisor";

  it("classifyEdits marks supervisor-created shift as adjusted (employee can't edit)", () => {
    const edits = [
      {
        shift_id: 42,
        edited_by: SUP,
        field_changed: "created",
        reason: "Manually added: Employee forgot to clock in",
      },
    ];
    const { editedByMe, adjustedByOthers, fieldsByShift } = classifyEdits(edits, ME);
    expect(editedByMe.size).toBe(0);
    expect(adjustedByOthers.has(42)).toBe(true);
    // Sentinel must NOT pollute the per-field quota map
    expect(fieldsByShift.size).toBe(0);
  });

  it("buildEditedFieldsMap ignores 'created' sentinel even when owned by current user", () => {
    const edits = [
      {
        shift_id: 7,
        edited_by: ME,
        field_changed: "created",
        reason: "Manually added: Manual correction",
      },
    ];
    const map = buildEditedFieldsMap(edits, ME);
    expect(map.size).toBe(0);
  });

  it("buildEditedFieldsMap also ignores rows whose reason starts with 'Manually added'", () => {
    // Defensive: even if a future change uses a different field_changed value,
    // the reason-prefix branch should still skip it.
    const edits = [
      {
        shift_id: 8,
        edited_by: ME,
        field_changed: "clock_in",
        reason: "Manually added: edge case",
      },
    ];
    const map = buildEditedFieldsMap(edits, ME);
    expect(map.size).toBe(0);
  });

  it("formatEditHistoryRow renders 'Added by ...' natural language for manual-add", () => {
    const row = formatEditHistoryRow({
      shift_id: 99,
      field_changed: "created",
      old_value: null,
      new_value: '{"clock_in":"2026-06-03T17:00:00Z"}',
      edited_by_name: "Pavel",
      reason: "Manually added: Employee forgot to clock in",
      created_at: "2026-06-04T18:30:00.000Z",
    });
    expect(row).toMatch(/^Added by Pavel at /);
    expect(row).toContain('"Employee forgot to clock in"');
    // Must NOT contain raw JSON snapshot or 'created' field label
    expect(row).not.toContain('{"clock_in');
    expect(row).not.toContain("(created)");
  });

  it("formatEditHistoryRow strips the 'Manually added:' prefix from the rendered note", () => {
    const row = formatEditHistoryRow({
      shift_id: 100,
      field_changed: "created",
      edited_by_name: "Yuri",
      reason: "Manually added: Phone died / no access",
      created_at: "2026-06-04T18:30:00.000Z",
    });
    expect(row).toContain("Yuri");
    expect(row).toContain('"Phone died / no access"');
    expect(row).not.toContain("Manually added:");
  });
});
