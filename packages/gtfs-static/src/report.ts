import type { StaticImportReport } from './types.js';

export function sanitizeReportMessage(message: string): string {
  return message
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 512);
}

export function formatHumanReport(report: StaticImportReport): string {
  const lines = [
    `Static Madrid import: ${report.result}`,
    `Source: ${report.source.kind} ${report.source.display}`,
    `Fetch: ${report.fetch.status}${report.fetch.httpStatus === undefined ? '' : ` (HTTP ${report.fetch.httpStatus})`}`,
  ];
  if (report.checksum !== undefined) lines.push(`SHA-256: ${report.checksum}`);
  if (report.feedVersionId !== undefined) lines.push(`Feed version: ${report.feedVersionId} (${report.feedVersionStatus ?? report.result})`);
  if (report.retained !== undefined) {
    lines.push(
      `Retained: ${report.retained.routes} routes, ${report.retained.trips} trips, ${report.retained.stops} stops, ${report.retained.stopTimes} stop times, ${report.retained.shapes} shapes`,
    );
  }
  if (report.discarded !== undefined) {
    lines.push(`Discarded national: ${report.discarded.routes} routes, ${report.discarded.trips} trips, ${report.discarded.stops} stops, ${report.discarded.stopTimes} stop times`);
  }
  lines.push(`Activation: ${report.activation}; duration: ${report.totalDurationMs} ms`);
  if (report.previousVersionId !== undefined) lines.push(`Previous version: ${report.previousVersionId}`);
  for (const warning of report.warnings.slice(0, 20)) lines.push(`Warning: ${sanitizeReportMessage(warning)}`);
  if (report.error !== undefined) lines.push(`Rejected: ${report.error.code}: ${sanitizeReportMessage(report.error.message)}`);
  return `${lines.join('\n')}\n`;
}
