import { describe, it, expect } from "vitest";
import { parseFFmpegTimeSeconds, calculatePercent } from "../lib/progress.js";

describe("parseFFmpegTimeSeconds", () => {
  it("parses a valid ffmpeg time= line", () => {
    const line = "frame=  452 fps=181 q=31.0 size=N/A time=00:00:07.50 bitrate=N/A speed=3x";
    expect(parseFFmpegTimeSeconds(line)).toBe(7.5);
  });

  it("correctly converts hours and minutes", () => {
    const line = "time=01:02:03.00 bitrate=N/A";
    expect(parseFFmpegTimeSeconds(line)).toBe(1 * 3600 + 2 * 60 + 3);
  });

  it("returns null for a line with no time= field", () => {
    const line = "libavutil      60.  8.100 / 60.  8.100";
    expect(parseFFmpegTimeSeconds(line)).toBeNull();
  });

  it("returns null for malformed time format", () => {
    const line = "time=notatime bitrate=N/A";
    expect(parseFFmpegTimeSeconds(line)).toBeNull();
  });
});

describe("calculatePercent — regression test for the rounding bug", () => {
  it("returns 0% at the very start", () => {
    expect(calculatePercent(0, 15)).toBe(0);
  });

  it("returns 50% at the halfway point", () => {
    expect(calculatePercent(7.5, 15)).toBe(50);
  });

  it("returns 100% at completion", () => {
    expect(calculatePercent(15, 15)).toBe(100);
  });

  it("returns intermediate values, not just 0 or 100 — this is the exact bug that shipped previously", () => {
    // The original bug: Math.round(x/y) * 100 rounds the 0-1 FRACTION first,
    // which can only ever produce 0 or 100 — never anything in between.
    // This test would have failed against that buggy implementation.
    expect(calculatePercent(1, 15)).toBeGreaterThan(0);
    expect(calculatePercent(1, 15)).toBeLessThan(50);
    expect(calculatePercent(1, 15)).toBe(7); // 1/15 = 6.67% -> rounds to 7

    expect(calculatePercent(10, 15)).toBe(67); // 10/15 = 66.67% -> rounds to 67
  });

  it("caps at 100 even if currentSeconds slightly exceeds duration", () => {
    // ffmpeg's reported time can occasionally overshoot the probed duration by a fraction of a second
    expect(calculatePercent(15.2, 15)).toBe(100);
  });
});