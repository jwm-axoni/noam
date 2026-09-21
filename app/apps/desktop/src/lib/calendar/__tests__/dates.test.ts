import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  compare,
  isoWeek,
  isSameMonth,
  monthGrid,
  startOfWeek,
} from "../dates";

describe("isoWeek", () => {
  it("crosses a year boundary forward (2026-W53 spills into January)", () => {
    expect(isoWeek("2026-12-31")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
  });

  it("crosses a year boundary backward (December belongs to next year's W01)", () => {
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
  });

  it("agrees with the pinned values in engine.variables.test.ts", () => {
    expect(isoWeek("2027-01-03")).toEqual({ year: 2026, week: 53 }); // Sunday
    expect(isoWeek("2027-01-04")).toEqual({ year: 2027, week: 1 }); // Monday
    expect(isoWeek("2025-12-29")).toEqual({ year: 2026, week: 1 }); // Monday before
    expect(isoWeek("2025-12-28")).toEqual({ year: 2025, week: 52 }); // Sunday before
  });
});

describe("startOfWeek", () => {
  // 2026-09-20 is a Sunday.
  it("Sunday start (0) treats Sunday as the first day of its own week", () => {
    expect(startOfWeek("2026-09-20", 0)).toBe("2026-09-20");
    expect(startOfWeek("2026-09-23", 0)).toBe("2026-09-20");
  });

  it("Monday start (1) rolls Sunday back to the previous Monday", () => {
    expect(startOfWeek("2026-09-20", 1)).toBe("2026-09-14");
    expect(startOfWeek("2026-09-23", 1)).toBe("2026-09-21");
  });

  it("Saturday start (6) treats Saturday as the first day", () => {
    expect(startOfWeek("2026-09-19", 6)).toBe("2026-09-19");
    expect(startOfWeek("2026-09-20", 6)).toBe("2026-09-19");
  });
});

describe("addDays", () => {
  it("stays whole days across a US DST spring-forward (2026-03-08)", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("stays whole days across a US DST fall-back (2026-11-01)", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("monthGrid", () => {
  it("is always 6 rows of 7 days", () => {
    const grid = monthGrid(2026, 9, 1);
    expect(grid).toHaveLength(6);
    for (const row of grid) expect(row).toHaveLength(7);
  });

  it("pads with the previous/next month and starts each row on weekStart", () => {
    // September 2026 starts on a Tuesday; Monday-start grid should lead with
    // the last two days of August.
    const grid = monthGrid(2026, 9, 1);
    expect(grid[0]).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
  });

  it("respects a Sunday week start", () => {
    const grid = monthGrid(2026, 9, 0);
    expect(grid[0]![0]).toBe("2026-08-30");
  });
});

describe("addMonths", () => {
  it("clamps to the last day of a shorter target month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
  });

  it("crosses a year boundary in both directions", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
});

describe("compare / isSameMonth", () => {
  it("compare orders chronologically", () => {
    expect(compare("2026-01-01", "2026-01-02")).toBeLessThan(0);
    expect(compare("2026-01-02", "2026-01-01")).toBeGreaterThan(0);
    expect(compare("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("isSameMonth compares year+month only", () => {
    expect(isSameMonth("2026-09-01", "2026-09-30")).toBe(true);
    expect(isSameMonth("2026-09-30", "2026-10-01")).toBe(false);
  });
});
