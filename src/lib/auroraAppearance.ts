export type AuroraEffects = "full" | "balanced" | "reduced";

const storageKey = "aurora.appearance.effects";

export function initializeAuroraAppearance(): AuroraEffects {
  let mode: AuroraEffects = "balanced";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "full" || saved === "reduced") mode = saved;
  } catch {
    // WebView profiles with unavailable storage still use the balanced theme.
  }
  document.documentElement.dataset.auroraEffects = mode;
  return mode;
}

export function saveAuroraAppearance(mode: AuroraEffects) {
  localStorage.setItem(storageKey, mode);
  document.documentElement.dataset.auroraEffects = mode;
}
