import { planParts, PART_SIZE, utcOffsetHours } from "./uploadClient.js";
import assert from "node:assert/strict";
import { test } from "node:test";

test("splits on PART_SIZE boundaries, remainder last", () => {
  // The real file: 9,699,328 bytes, which Plaud asked for in 2 parts.
  const ranges = planParts(9_699_328, 2);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.end - ranges[0]!.start, PART_SIZE, "first part is a full 5 MiB");
  assert.equal(ranges[1]!.end - ranges[1]!.start, 9_699_328 - PART_SIZE);
  assert.equal(ranges[1]!.end, 9_699_328, "the last part ends at the end of the file");
});

test("every part but the last meets S3's 5 MiB minimum", () => {
  // Equal division would produce undersized parts and S3 would refuse to
  // reassemble — the bug this function exists to prevent.
  for (const size of [9_699_328, 11_000_000, 26_214_400, 5_242_881]) {
    const count = Math.ceil(size / PART_SIZE);
    const ranges = planParts(size, count);
    for (const r of ranges.slice(0, -1)) {
      assert.ok(r.end - r.start >= PART_SIZE, `part ${r.partNumber} of a ${size}-byte file is too small`);
    }
    assert.equal(ranges.at(-1)!.end, size, "parts cover the whole file");
    assert.equal(ranges[0]!.start, 0);
  }
});

test("a single-part file is one range covering everything", () => {
  const ranges = planParts(1_000, 1);
  assert.deepEqual(ranges, [{ start: 0, end: 1_000, partNumber: 1 }]);
});

test("ranges are contiguous with no gaps or overlap", () => {
  const ranges = planParts(12_345_678, 3);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]!.start, ranges[i - 1]!.end);
});

test("part numbers are 1-based, as S3 requires", () => {
  assert.deepEqual(planParts(20_000_000, 4).map((r) => r.partNumber), [1, 2, 3, 4]);
});

test("utcOffsetHours matches the offset confirm_upload expects", () => {
  const offset = utcOffsetHours(new Date());
  assert.equal(typeof offset, "number");
  assert.ok(Math.abs(offset) <= 14);
});
