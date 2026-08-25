import type { DataStatus, EvidenceState } from "./contracts";

export const PUNCTUALITY_THRESHOLD_SECONDS = 120;

export function formatDelay(seconds: number | null, lang: "es" | "en"): string {
  if (seconds === null) return lang === "es" ? "Sin dato" : "No data";
  const sign = seconds < 0 ? "−" : seconds > 0 ? "+" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  if (minutes === 0) return `${sign}${remainder} s`;
  return `${sign}${minutes} min ${String(remainder).padStart(2, "0")} s`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function delayBand(seconds: number | null): "unknown" | "punctual" | "mild" | "delayed" | "severe" {
  if (seconds === null) return "unknown";
  if (seconds <= PUNCTUALITY_THRESHOLD_SECONDS) return "punctual";
  if (seconds <= 300) return "mild";
  if (seconds <= 600) return "delayed";
  return "severe";
}

export function evidenceLabel(state: EvidenceState, lang: "es" | "en"): string {
  const labels: Record<EvidenceState, readonly [string, string]> = {
    reported_only: ["Reportado por Renfe", "Renfe reported"],
    observed_presence: ["Presencia observada", "Observed presence"],
    skipped: ["Parada omitida", "Skipped stop"],
    canceled: ["Cancelado", "Canceled"],
    missing_evidence: ["Sin evidencia", "Missing evidence"],
    pending: ["Pendiente", "Pending"],
  };
  return labels[state][lang === "es" ? 0 : 1];
}

export function statusLabel(status: DataStatus, lang: "es" | "en"): string {
  const labels: Record<DataStatus, readonly [string, string]> = {
    live: ["En directo", "Live"],
    paused: ["Actualización pausada", "Refresh paused"],
    stale: ["Datos desactualizados", "Stale data"],
    outage: ["Fuente no disponible", "Source unavailable"],
    cached: ["Copia sin conexión", "Offline cache"],
    overnight: ["Sin trenes activos", "No active trains"],
  };
  return labels[status][lang === "es" ? 0 : 1];
}
