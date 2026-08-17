import { StaticImportError } from './types.js';

const timePattern = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/u;

export function parseGtfsTime(value: string, field = 'GTFS time'): number | null {
  if (value === '') return null;
  const match = timePattern.exec(value);
  if (match === null) {
    throw new StaticImportError(
      'validation',
      'gtfs.time.invalid',
      `${field} must use H:MM:SS with hours from 0 through 99`,
      { field, value: value.slice(0, 32) },
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isSafeInteger(hours) || hours > 99) {
    throw new StaticImportError(
      'validation',
      'gtfs.time.invalid',
      `${field} hour must be between 0 and 99`,
      { field, value: value.slice(0, 32) },
    );
  }
  return hours * 3600 + minutes * 60 + seconds;
}
