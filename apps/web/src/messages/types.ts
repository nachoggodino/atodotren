export interface Messages {
  nav: { home: string; live: string; history: string; methodology: string; menu: string; close: string; language: string; theme: string; refresh: string; paused: string; active: string; primary: string; light: string; dark: string };
  landing: { eyebrow: string; title: string; body: string; searchLabel: string; searchPlaceholder: string; liveAction: string; historyAction: string; emptySearch: string; searchError: string; summaryLive: string; summaryHistory: string; liveSummaryDetail: string; historySummaryDetail: string; activeTrains: string; activeDelay: string; todayDelay: string; delayTrend: string; delayTrendWindow: string; footerDescription: string; methodology: string };
  common: {
    coverage: string; freshness: string; finalized: string; processing: string; finalizationUnknown: string; precision: string; updated: string; scheduled: string; observed: string; punctuality: string; mean: string; median: string; cancellation: string; missing: string; noData: string; details: string; direction: string; directionA: string; directionB: string; line: string; station: string; loading: string; state: string; confidence: string; dataMetadata: string; unavailable: string;
    sourceHealthy: string; sourceStale: string; sourceUnavailable: string; sourceOvernight: string; sourceHistorical: string; sourceReference: string;
    freshnessFresh: string; freshnessStale: string; freshnessUnknown: string; freshnessNotApplicable: string;
    precisionReported: string; precisionCalculated: string; precisionMixed: string; precisionAggregate: string; precisionSchematic: string;
    confidenceHigh: string; confidenceMedium: string; confidenceLow: string; confidenceUnavailable: string;
    evidenceReportedOnly: string; evidenceObservedPresence: string; evidenceSkipped: string; evidenceCanceled: string; evidenceMissing: string; evidencePending: string;
    algorithmNone: string; algorithmMixed: string;
  };
  live: { title: string; networkTitle: string; comparison: string; comparisonUnavailable: string; comparisonInsufficient: string; trains: string; activeTrains: string; schematic: string; inferred: string; reported: string; positionUnavailable: string; nextArrival: string; probableArrival: string; sourceArrival: string; observedPresence: string; autoRefresh: string; refreshing: string; hiddenTabPause: string; overnight: string; todayDistributionTitle: string; todayDistributionBody: string; comparisonDescription: string; stationContext: string };
  history: { title: string; trend: string; distribution: string; rankings: string; rankingsUnavailable: string; matrix: string; filters: string; from: string; to: string; hour: string; allHours: string; allDirections: string; apply: string; sample: string; insufficient: string; currentDay: string; finalizationUnknown: string; days: string; allDays: string; weekdays: string; weekend: string; monday: string; tuesday: string; wednesday: string; thursday: string; friday: string; matrixRetention: string; matrixNoData: string; matrixFailed: string; legend: string; stationColumn: string; canceled: string; skipped: string; pending: string };
  charts: { delayDistribution: string; meanDelayTrend: string; early: string; punctual: string; accessibleData: string; date: string; value: string };
  errors: { temporaryTitle: string; temporaryBody: string; retry: string; invalidFilters: string };
  methodology: { title: string; intro: string };
  offline: { status: string; cached: string; cachedAt: string; unavailable: string };
}
