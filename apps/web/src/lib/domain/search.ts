export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function normalizedLineAlias(value: string): string {
  const normalized = normalizeSearch(value);
  const match = /^c0*(\d+)$/.exec(normalized);
  return match?.[1] === undefined ? normalized : `c${Number(match[1])}`;
}
