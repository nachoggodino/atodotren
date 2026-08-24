export const LIVE_REFRESH_MS = 30_000;
export const LIVE_STALE_AFTER_MS = 120_000;
export const CURRENT_HISTORY_CACHE_SECONDS = 300;
export const FINAL_HISTORY_CACHE_SECONDS = 3_600;
export const CATALOG_CACHE_SECONDS = 86_400;
export const MATRIX_MAX_DAYS = 30;
export const MATRIX_MAX_ROWS = 6_000;
export const SEARCH_RESULT_LIMIT = 12;
export const MIN_LINE_RANKING_SAMPLE = 100;
export const MIN_STATION_RANKING_SAMPLE = 30;
export const PUNCTUALITY_THRESHOLD_SECONDS = 120;

export const FALLBACK_LINE_COLORS: Readonly<Record<string, string>> = {
  c1: "#5aa1d8",
  c2: "#2f7f50",
  c3: "#8e63a9",
  c4: "#285d9b",
  c5: "#e0a52b",
  c7: "#d64e4b",
  c8: "#7c6d62",
  c10: "#8b6cae",
};

export const CHART = {
  height: 260,
  animationMs: 220,
  margin: { top: 8, right: 12, bottom: 4, left: -16 },
} as const;
