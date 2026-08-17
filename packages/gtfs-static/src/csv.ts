import { createReadStream } from 'node:fs';

import { StaticImportError } from './types.js';

export interface CsvSchema {
  readonly file: string;
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

function csvError(file: string, code: string, message: string, row: number): StaticImportError {
  return new StaticImportError('csv', code, `${file}: ${message} at record ${row}`, {
    file,
    record: row,
  });
}

export async function* readCsvRecords(
  path: string,
  schema: CsvSchema,
  maxRowBytes: number,
): AsyncGenerator<Readonly<Record<string, string>>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = createReadStream(path);
  let headers: string[] | undefined;
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let skipLf = false;
  let rowBytes = 0;
  let recordNumber = 1;

  const completeRecord = (): Readonly<Record<string, string>> | undefined => {
    fields.push(field);
    field = '';
    let completed = fields;
    fields = [];
    rowBytes = 0;
    if (headers === undefined) {
      if (completed.length > 0) completed[0] = completed[0]?.replace(/^\uFEFF/u, '') ?? '';
      completed = completed.map((name) => name.trim());
      if (completed.length === 1 && completed[0] === '') {
        throw csvError(schema.file, 'csv.header.empty', 'header is empty', recordNumber);
      }
      const duplicates = completed.filter((name, index) => completed.indexOf(name) !== index);
      if (duplicates.length > 0 || completed.some((name) => name === '')) {
        throw csvError(schema.file, 'csv.header.malformed', 'header contains empty or duplicate columns', recordNumber);
      }
      const allowed = new Set([...schema.required, ...(schema.optional ?? [])]);
      const missing = schema.required.filter((name) => !completed.includes(name));
      if (missing.length > 0) {
        throw csvError(
          schema.file,
          'csv.header.missing',
          `missing required columns: ${missing.join(', ')}`,
          recordNumber,
        );
      }
      // Unknown GTFS extension columns are allowed and passed through. The importer
      // only reads explicitly named fields, keeping vendor additions provider-neutral.
      void allowed;
      headers = completed;
      recordNumber += 1;
      return undefined;
    }
    if (completed.length === 1 && completed[0] === '') {
      recordNumber += 1;
      return undefined;
    }
    if (completed.length !== headers.length) {
      throw csvError(
        schema.file,
        'csv.row.columns',
        `expected ${headers.length} columns but found ${completed.length}`,
        recordNumber,
      );
    }
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header !== undefined) record[header] = completed[index] ?? '';
    }
    recordNumber += 1;
    return record;
  };

  const processText = function* (text: string): Generator<Readonly<Record<string, string>>> {
    for (const character of text) {
      if (skipLf) {
        skipLf = false;
        if (character === '\n') continue;
      }
      rowBytes += Buffer.byteLength(character, 'utf8');
      if (rowBytes > maxRowBytes) {
        throw csvError(schema.file, 'csv.row.too_large', `record exceeds ${maxRowBytes} bytes`, recordNumber);
      }
      if (inQuotes) {
        if (afterQuote) {
          if (character === '"') {
            field += '"';
            afterQuote = false;
            continue;
          }
          inQuotes = false;
          afterQuote = false;
          if (character === ',') {
            fields.push(field);
            field = '';
            continue;
          }
          if (character === '\n' || character === '\r') {
            if (character === '\r') skipLf = true;
            const record = completeRecord();
            if (record !== undefined) yield record;
            continue;
          }
          throw csvError(schema.file, 'csv.quote.malformed', 'unexpected character after closing quote', recordNumber);
        }
        if (character === '"') afterQuote = true;
        else field += character;
        continue;
      }
      if (character === '"') {
        if (field !== '') {
          throw csvError(schema.file, 'csv.quote.malformed', 'quote appears inside an unquoted field', recordNumber);
        }
        inQuotes = true;
      } else if (character === ',') {
        fields.push(field);
        field = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r') skipLf = true;
        const record = completeRecord();
        if (record !== undefined) yield record;
      } else {
        field += character;
      }
    }
  };

  try {
    for await (const chunk of stream) {
      let text: string;
      try {
        text = decoder.decode(chunk as Buffer, { stream: true });
      } catch (_error) {
        throw csvError(schema.file, 'csv.encoding.invalid', 'content is not valid UTF-8', recordNumber);
      }
      yield* processText(text);
    }
    let finalText: string;
    try {
      finalText = decoder.decode();
    } catch {
      throw csvError(schema.file, 'csv.encoding.invalid', 'content is not valid UTF-8', recordNumber);
    }
    yield* processText(finalText);
    if (inQuotes && !afterQuote) {
      throw csvError(schema.file, 'csv.quote.unclosed', 'quoted field is not closed', recordNumber);
    }
    if (headers === undefined || fields.length > 0 || field !== '' || afterQuote) {
      const record = completeRecord();
      if (record !== undefined) yield record;
    }
    if (headers === undefined) {
      throw csvError(schema.file, 'csv.header.empty', 'file has no header', 1);
    }
  } finally {
    stream.destroy();
  }
}
