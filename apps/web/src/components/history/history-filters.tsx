"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, CalendarDays, CircleArrowRight, Filter } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { HistoryFilters } from "@/lib/domain/contracts";
import { calendarDayOfWeek, calendarDaysInclusive, currentMadridDate, offsetCalendarDate } from "@/lib/domain/dates";
import type { Messages } from "@/messages/types";

const MAX_HISTORY_RANGE_DAYS = 366;
type DatePreset = "today" | "yesterday" | "last7" | "lastWeek" | "thisMonth" | "last30" | "thisYear";

function formatDisplayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function presetRange(preset: DatePreset): { readonly from: string; readonly to: string } {
  const today = currentMadridDate();
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": {
      const yesterday = offsetCalendarDate(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7": return { from: offsetCalendarDate(today, -6), to: today };
    case "lastWeek": {
      const daysSinceMonday = (calendarDayOfWeek(today) + 6) % 7;
      const from = offsetCalendarDate(today, -(daysSinceMonday + 7));
      return { from, to: offsetCalendarDate(from, 6) };
    }
    case "thisMonth": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last30": return { from: offsetCalendarDate(today, -29), to: today };
    case "thisYear": return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

function hourStartLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}h`;
}

function hourEndLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}h59`;
}

function hourRangeLabel(from: number, to: number): string {
  return `${hourStartLabel(from)}–${hourEndLabel(to)}`;
}

function weekdayLabel(day: number, messages: Messages): string {
  switch (day) {
    case 0: return messages.history.sunday;
    case 1: return messages.history.monday;
    case 2: return messages.history.tuesday;
    case 3: return messages.history.wednesday;
    case 4: return messages.history.thursday;
    case 5: return messages.history.friday;
    case 6: return messages.history.saturday;
    default: return messages.history.allDays;
  }
}

function shortWeekdayLabel(day: number, messages: Messages): string {
  return weekdayLabel(day, messages).slice(0, 3);
}

function committedHourRange(filters: HistoryFilters): { readonly from: number; readonly to: number } {
  if (filters.hour === null) return { from: 0, to: 23 };
  return { from: filters.hour, to: filters.hourTo ?? filters.hour };
}

function activeFiltersLabel(filters: HistoryFilters, messages: Messages): string {
  const labels: string[] = [];
  if (filters.weekdays.length > 0) labels.push(filters.weekdays.map((day) => shortWeekdayLabel(day, messages)).join(", "));
  if (filters.hour !== null) {
    const hours = committedHourRange(filters);
    labels.push(hourRangeLabel(hours.from, hours.to));
  }
  return labels.length === 0 ? messages.history.noActiveFilters : labels.join(" · ");
}

function ApplyButton({ label, disabled = false, onClick, testId }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void; readonly testId: string }) {
  return (
    <button
      aria-label={label}
      className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--landing-highlight)] transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-90 disabled:cursor-not-allowed disabled:opacity-30"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <CircleArrowRight className="size-5" />
    </button>
  );
}

const POPOVER_CLASS = "z-[80] w-[60vw] max-w-[48rem] min-w-[20rem] rounded-xl border border-border bg-surface-strong p-4 text-foreground shadow-[var(--shadow-float)] outline-none max-sm:w-[calc(100vw-1rem)] max-sm:min-w-0";
const FIELD_CLASS = "min-h-9 min-w-0 w-full appearance-none rounded-md border border-border bg-surface px-1.5 text-center text-xs tabular-nums text-foreground";
const MINI_BUTTON_CLASS = "rounded-full border border-border bg-surface px-2.5 py-1 text-[10px] font-semibold leading-4 transition-[background-color,border-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-95 active:opacity-75";
const RANGE_FIELDS_CLASS = "mx-auto grid w-fit grid-cols-[7rem_auto_7rem_auto] items-end gap-1.5 sm:grid-cols-[8rem_auto_8rem_auto] sm:gap-2";

export function HistoryFiltersForm({ filters, messages }: { readonly filters: HistoryFilters; readonly messages: Messages }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committedHours = committedHourRange(filters);
  const [dateOpen, setDateOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(filters.from);
  const [dateTo, setDateTo] = useState(filters.to);
  const [weekdayDraft, setWeekdayDraft] = useState<number[]>([...filters.weekdays]);
  const [hourFromDraft, setHourFromDraft] = useState(String(committedHours.from));
  const [hourToDraft, setHourToDraft] = useState(String(committedHours.to));

  const navigate = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete("direction");
    const query = params.toString();
    window.location.assign(query === "" ? pathname : `${pathname}?${query}`);
  };

  const applyDates = (from: string, to: string) => {
    setDateOpen(false);
    navigate((params) => {
      params.set("from", from);
      params.set("to", to);
    });
  };

  const applySecondaryFilters = () => {
    const hourFrom = Number(hourFromDraft);
    const hourTo = Number(hourToDraft);
    setFilterOpen(false);
    navigate((params) => {
      if (weekdayDraft.length === 0) params.delete("weekdays");
      else params.set("weekdays", [...weekdayDraft].sort((left, right) => left - right).join(","));
      params.delete("hour");
      if (hourFrom === 0 && hourTo === 23) {
        params.delete("hourFrom");
        params.delete("hourTo");
      } else {
        params.set("hourFrom", String(hourFrom));
        params.set("hourTo", String(hourTo));
      }
    });
  };

  const setDatePopoverOpen = (open: boolean) => {
    if (open) {
      setDateFrom(filters.from);
      setDateTo(filters.to);
    }
    setDateOpen(open);
  };

  const setFilterPopoverOpen = (open: boolean) => {
    if (open) {
      const hours = committedHourRange(filters);
      setWeekdayDraft([...filters.weekdays]);
      setHourFromDraft(String(hours.from));
      setHourToDraft(String(hours.to));
    }
    setFilterOpen(open);
  };

  const toggleWeekday = (day: number) => {
    setWeekdayDraft((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort((left, right) => left - right));
  };

  const selectedDays = calendarDaysInclusive(dateFrom, dateTo);
  const validDateRange = Number.isFinite(selectedDays) && selectedDays >= 1 && selectedDays <= MAX_HISTORY_RANGE_DAYS;
  const hourFromNumber = Number(hourFromDraft);
  const hourToNumber = Number(hourToDraft);
  const validHourRange = Number.isInteger(hourFromNumber) && Number.isInteger(hourToNumber) && hourFromNumber >= 0 && hourToNumber <= 23 && hourFromNumber <= hourToNumber;
  const presets: readonly { readonly id: DatePreset; readonly label: string }[] = [
    { id: "today", label: messages.history.today },
    { id: "yesterday", label: messages.history.yesterday },
    { id: "last7", label: messages.history.last7Days },
    { id: "lastWeek", label: messages.history.lastWeek },
    { id: "thisMonth", label: messages.history.thisMonth },
    { id: "last30", label: messages.history.last30Days },
    { id: "thisYear", label: messages.history.thisYear },
  ];
  const weekdays = [1, 2, 3, 4, 5, 6, 0] as const;

  return (
    <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,.65fr)] gap-2" data-testid="explore-filter-bar">
      <Ariakit.PopoverProvider open={dateOpen} setOpen={setDatePopoverOpen}>
        <Ariakit.PopoverDisclosure
          aria-label={messages.history.dateRange}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-strong px-3 text-[11px] font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75"
          data-testid="explore-date-filter"
          type="button"
        >
          <CalendarDays className="size-4 shrink-0 text-[var(--landing-highlight)]" />
          <span className="min-w-0 truncate tabular-nums">{formatDisplayDate(filters.from)}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted" />
          <span className="min-w-0 truncate tabular-nums">{formatDisplayDate(filters.to)}</span>
        </Ariakit.PopoverDisclosure>
        <Ariakit.Popover className={POPOVER_CLASS} data-testid="explore-date-popover" gutter={8} portal>
          <Ariakit.PopoverHeading className="sr-only">{messages.history.dateRange}</Ariakit.PopoverHeading>
          <div className={RANGE_FIELDS_CLASS}>
            <label className="grid min-w-0 gap-1 text-[10px] font-bold text-muted">
              {messages.history.from}
              <input className={`${FIELD_CLASS} [&::-webkit-calendar-picker-indicator]:hidden`} onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
            </label>
            <ArrowRight className="mb-2.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
            <label className="grid min-w-0 gap-1 text-[10px] font-bold text-muted">
              {messages.history.to}
              <input className={`${FIELD_CLASS} [&::-webkit-calendar-picker-indicator]:hidden`} onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
            </label>
            <ApplyButton disabled={!validDateRange} label={messages.history.apply} onClick={() => applyDates(dateFrom, dateTo)} testId="explore-date-apply" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {presets.map((preset) => (
              <button
                className={MINI_BUTTON_CLASS}
                key={preset.id}
                onClick={() => {
                  const range = presetRange(preset.id);
                  applyDates(range.from, range.to);
                }}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </Ariakit.Popover>
      </Ariakit.PopoverProvider>

      <Ariakit.PopoverProvider open={filterOpen} setOpen={setFilterPopoverOpen}>
        <Ariakit.PopoverDisclosure
          aria-label={messages.history.filters}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-strong px-3 text-[11px] font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75"
          data-testid="explore-secondary-filter"
          type="button"
        >
          <Filter className="size-4 shrink-0 text-[var(--landing-highlight)]" />
          <span className="min-w-0 truncate">{activeFiltersLabel(filters, messages)}</span>
        </Ariakit.PopoverDisclosure>
        <Ariakit.Popover className={POPOVER_CLASS} data-testid="explore-filter-popover" gutter={8} portal>
          <Ariakit.PopoverHeading className="sr-only">{messages.history.filters}</Ariakit.PopoverHeading>
          <div className={RANGE_FIELDS_CLASS}>
            <label className="grid min-w-0 gap-1 text-[10px] font-bold text-muted">
              {messages.history.from}
              <select className={FIELD_CLASS} onChange={(event) => setHourFromDraft(event.target.value)} value={hourFromDraft}>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourStartLabel(hour)}</option>)}
              </select>
            </label>
            <ArrowRight className="mb-2.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
            <label className="grid min-w-0 gap-1 text-[10px] font-bold text-muted">
              {messages.history.to}
              <select className={FIELD_CLASS} onChange={(event) => setHourToDraft(event.target.value)} value={hourToDraft}>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourEndLabel(hour)}</option>)}
              </select>
            </label>
            <ApplyButton disabled={!validHourRange} label={messages.history.apply} onClick={applySecondaryFilters} testId="explore-filter-apply" />
          </div>
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] font-bold text-muted">{messages.history.weekdayFilter}</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                aria-pressed={weekdayDraft.length === 0}
                className={`${MINI_BUTTON_CLASS} ${weekdayDraft.length === 0 ? "border-[var(--landing-highlight)] bg-muted-soft text-[var(--landing-highlight)]" : ""}`}
                onClick={() => setWeekdayDraft([])}
                type="button"
              >
                {messages.history.allDays.replace(/\s.+$/, "")}
              </button>
              {weekdays.map((day) => {
                const selected = weekdayDraft.includes(day);
                return (
                  <button
                    aria-pressed={selected}
                    className={`${MINI_BUTTON_CLASS} ${selected ? "border-[var(--landing-highlight)] bg-muted-soft text-[var(--landing-highlight)]" : ""}`}
                    key={day}
                    onClick={() => toggleWeekday(day)}
                    type="button"
                  >
                    {shortWeekdayLabel(day, messages)}
                  </button>
                );
              })}
            </div>
          </div>
        </Ariakit.Popover>
      </Ariakit.PopoverProvider>
    </div>
  );
}
