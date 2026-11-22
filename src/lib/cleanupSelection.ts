const REVIEW_REQUIRED = new Set(["recycle_bin", "shader_cache", "crash_dumps", "windows_update"]);

type CategorySelection = {
  id: string;
  size_bytes: number;
  files_count: number;
  requires_admin: boolean;
};

export function requiresCleanupReview(id: string): boolean {
  return REVIEW_REQUIRED.has(id);
}

export function canSelectCleanup(category: CategorySelection, isElevated: boolean): boolean {
  return (category.size_bytes > 0 || category.files_count > 0) &&
    (!category.requires_admin || isElevated);
}

export function recommendedCleanupIds(categories: CategorySelection[], isElevated: boolean): string[] {
  return categories
    .filter((category) => canSelectCleanup(category, isElevated) && !requiresCleanupReview(category.id))
    .map((category) => category.id);
}
