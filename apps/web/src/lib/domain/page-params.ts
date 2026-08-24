import { parseHistoryFilters } from "./filters";

export type PageSearchParams = Readonly<Record<string, string | string[] | undefined>>;

export function historyFiltersFromPage(params: PageSearchParams) {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") values.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) values.set(key, value[0]);
  }
  return parseHistoryFilters(values);
}
