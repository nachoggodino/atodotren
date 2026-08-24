export interface Messages {
  nav: { home: string; live: string; history: string; methodology: string; menu: string; close: string; language: string; theme: string; refresh: string; paused: string; active: string };
  landing: { eyebrow: string; title: string; body: string; searchLabel: string; searchPlaceholder: string; liveAction: string; historyAction: string; emptySearch: string; summaryLive: string; summaryHistory: string; methodology: string };
  common: { coverage: string; freshness: string; finalized: string; unfinalized: string; precision: string; updated: string; scheduled: string; observed: string; punctuality: string; mean: string; median: string; cancellation: string; missing: string; noData: string; details: string; direction: string };
  live: { title: string; networkTitle: string; comparison: string; trains: string; schematic: string; inferred: string; reported: string; nextArrival: string; probableArrival: string; sourceArrival: string; observedPresence: string; autoRefresh: string; refreshing: string; overnight: string };
  history: { title: string; trend: string; distribution: string; rankings: string; matrix: string; filters: string; from: string; to: string; hour: string; allHours: string; allDirections: string; apply: string; sample: string; insufficient: string; currentDay: string };
  methodology: { title: string; intro: string };
  offline: { cached: string; cachedAt: string; unavailable: string };
}
