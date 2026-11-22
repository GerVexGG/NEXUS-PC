import test from "node:test";
import assert from "node:assert/strict";
import { canSelectCleanup, recommendedCleanupIds, requiresCleanupReview } from "../src/lib/cleanupSelection.ts";

const category = (id: string, requires_admin = false, size_bytes = 1024, files_count = 1) =>
  ({ id, requires_admin, size_bytes, files_count });

test("cleanup recommendations exclude review-only, empty, and out-of-scope categories", () => {
  const categories = [
    category("user_temp"),
    category("system_temp", true),
    category("shader_cache"),
    category("recycle_bin"),
    category("crash_dumps"),
    category("windows_update", true),
    category("empty_cache", false, 0, 0),
    category("zero_byte_files", false, 0),
  ];

  assert.deepEqual(recommendedCleanupIds(categories, false), ["user_temp", "zero_byte_files"]);
  assert.deepEqual(recommendedCleanupIds(categories, true), ["user_temp", "system_temp", "zero_byte_files"]);
  assert.ok(requiresCleanupReview("shader_cache"));
  assert.ok(canSelectCleanup(categories[2], false));
  assert.equal(canSelectCleanup(categories[5], false), false);
});
