"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, CalendarDays, Check, Filter } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { HistoryFilters } from "@/lib/domain/contracts";
import { calendarDayOfWeek, calendarDaysInclusive, currentMadridDate, offsetCalendarDate } from "@/lib/domain/dates";
import type { Messages } from "@/messages/types";
import { ExploreLoadingSkeleton } from "./explore-loading-skeleton";

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

function hourLabel(hour: number): string {
  return `${hour}h`;
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

function sameWeekdays(current: readonly number[], preset: readonly number[]): boolean {
  return current.length === preset.length && preset.every((day) => current.includes(day));
}

function ApplyButton({ label, disabled = false, onClick, testId }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void; readonly testId: string }) {
  return (
    <button
      aria-label={label}
      className="grid size-[2.625rem] shrink-0 place-items-center rounded-full bg-[var(--landing-highlight)] text-[var(--background)] shadow-sm transition-[filter,transform,opacity] duration-100 hover:brightness-95 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Check className="size-5 stroke-[2.75]" />
    </button>
  );
}

const POPOVER_BASE_CLASS = "z-[80] max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface-strong p-3 text-foreground shadow-[var(--shadow-float)] outline-none";
const DATE_POPOVER_CLASS = `${POPOVER_BASE_CLASS} w-[18.5rem]`;
const FILTER_POPOVER_CLASS = `${POPOVER_BASE_CLASS} w-[11.75rem]`;
const FILTER_DISCLOSURE_CLASS = "flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface-strong px-2.5 text-[11px] font-semibold leading-none transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75";
const FIELD_CLASS = "h-8 min-w-0 appearance-none rounded-md border border-border bg-surface px-2 text-center text-[15px] font-semibold leading-none tabular-nums text-foreground";
const DATE_FIELD_CLASS = `${FIELD_CLASS} w-[7.75rem] [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:text-center`;
const HOUR_FIELD_CLASS = `${FIELD_CLASS} w-[3.75rem] [text-align-last:center]`;
const MINI_BUTTON_CLASS = "h-6 rounded-full border border-border bg-surface px-2 text-[14px] font-semibold leading-none transition-[background-color,border-color,color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-95 active:opacity-75";
const WEEKDAY_BUTTON_CLASS = `${MINI_BUTTON_CLASS} aria-pressed:border-[var(--landing-highlight)] aria-pressed:bg-[var(--landing-highlight)] aria-pressed:text-[var(--background)] aria-pressed:hover:bg-[var(--landing-highlight)]`;
const LABEL_CLASS = "grid shrink-0 gap-0.5 text-center text-[13px] font-bold leading-none text-muted";

export function HistoryFiltersForm({ filters, messages }: { readonly filters: HistoryFilters; readonly messages: Messages }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const committedHours = committedHourRange(filters);
  const [dateOpen, setDateOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [dateFrom, setDateFrom] = useState(filters.from);
  const [dateTo, setDateTo] = useState(filters.to);
  const [weekdayDraft, setWeekdayDraft] = useState<number[]>([...filters.weekdays]);
  const [hourFromDraft, setHourFromDraft] = useState(String(committedHours.from));
  const [hourToDraft, setHourToDraft] = useState(String(committedHours.to));

  const navigate = (mutate: (params: URLSearchParams) => void) => {
    if (navigating) return;
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete("direction");
    const query = params.toString();
    const target = query === "" ? pathname : `${pathname}?${query}`;

    setNavigating(true);
    router.push(target, { scroll: false });
  };

  const applyDates = (from: string, to: string) => {
    navigate((params) => {
      params.set("from", from);
      params.set("to", to);
    });
  };

  const applySecondaryFilters = () => {
    const hourFrom = Number(hourFromDraft);
    const hourTo = Number(hourToDraft);
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
  const weekdayPresets: readonly { readonly label: string; readonly days: readonly number[] }[] = [
    { label: messages.history.weekdays, days: [1, 2, 3, 4, 5] },
    { label: messages.history.weekend, days: [0, 6] },
  ];
  const weekdays = [1, 2, 3, 4, 5, 6, 0] as const;

  return (
    <>
      {navigating ? <ExploreLoadingSkeleton overlay /> : null}
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-2" data-testid="explore-filter-bar">
        <Ariakit.PopoverProvider open={dateOpen} setOpen={setDatePopoverOpen}>
          <Ariakit.PopoverDisclosure
            aria-label={messages.history.dateRange}
            className={FILTER_DISCLOSURE_CLASS}
            data-testid="explore-date-filter"
            type="button"
          >
            <CalendarDays className="size-3.5 shrink-0 text-[var(--landing-highlight)]" />
            <span className="min-w-0 truncate tabular-nums">{formatDisplayDate(filters.from)}</span>
            <ArrowRight className="size-3 shrink-0 text-muted" />
            <span className="min-w-0 truncate tabular-nums">{formatDisplayDate(filters.to)}</span>
          </Ariakit.PopoverDisclosure>
          <Ariakit.Popover className={DATE_POPOVER_CLASS} data-testid="explore-date-popover" gutter={8} portal>
            <Ariakit.PopoverHeading className="sr-only">{messages.history.dateRange}</Ariakit.PopoverHeading>
            <div className="flex items-end gap-1.5">
              <label className={`${LABEL_CLASS} w-[7.75rem]`}>
                {messages.history.from}
                <input className={DATE_FIELD_CLASS} onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
              </label>
              <ArrowRight className="mb-2.5 size-3 shrink-0 text-muted" aria-hidden="true" />
              <label className={`${LABEL_CLASS} w-[7.75rem]`}>
                {messages.history.to}
                <input className={DATE_FIELD_CLASS} onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
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
            <div className="mt-3 flex justify-end">
              <ApplyButton disabled={!validDateRange} label={messages.history.apply} onClick={() => applyDates(dateFrom, dateTo)} testId="explore-date-apply" />
            </div>
          </Ariakit.Popover>
        </Ariakit.PopoverProvider>

        <Ariakit.PopoverProvider open={filterOpen} setOpen={setFilterPopoverOpen}>
          <Ariakit.PopoverDisclosure
            aria-label={messages.history.filters}
            className={FILTER_DISCLOSURE_CLASS}
            data-testid="explore-secondary-filter"
            type="button"
          >
            <Filter className="size-3.5 shrink-0 text-[var(--landing-highlight)]" />
            <span className="shrink-0 tabular-nums">{hourLabel(committedHours.from)}</span>
            <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 truncate tabular-nums">{hourLabel(committedHours.to)}</span>
          </Ariakit.PopoverDisclosure>
          <Ariakit.Popover className={FILTER_POPOVER_CLASS} data-testid="explore-filter-popover" gutter={8} portal>
            <Ariakit.PopoverHeading className="sr-only">{messages.history.filters}</Ariakit.PopoverHeading>
            <div className="flex items-end gap-1.5">
              <label className={`${LABEL_CLASS} w-[3.75rem]`}>
                {messages.history.from}
                <select className={HOUR_FIELD_CLASS} onChange={(event) => setHourFromDraft(event.target.value)} value={hourFromDraft}>
                  {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                </select>
              </label>
              <ArrowRight className="mb-2.5 size-3 shrink-0 text-muted" aria-hidden="true" />
              <label className={`${LABEL_CLASS} w-[3.75rem]`}>
                {messages.history.to}
                <select className={HOUR_FIELD_CLASS} onChange={(event) => setHourToDraft(event.target.value)} value={hourToDraft}>
                  {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-2">
              <p className="mb-1 text-[13px] font-bold leading-none text-muted">{messages.history.weekdayFilter}</p>
              <div className="flex flex-wrap gap-1">
                <button
                  aria-pressed={weekdayDraft.length === 0}
                  className={WEEKDAY_BUTTON_CLASS}
                  onClick={() => setWeekdayDraft([])}
                  type="button"
                >
                  {messages.history.allDays.replace(/\s.+$/, "")}
                </button>
                {weekdayPresets.map((preset) => {
                  const selected = sameWeekdays(weekdayDraft, preset.days);
                  return (
                    <button
                      aria-pressed={selected}
                      className={WEEKDAY_BUTTON_CLASS}
                      key={preset.label}
                      onClick={() => setWeekdayDraft([...preset.days])}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  );
                })}
                {weekdays.map((day) => {
                  const selected = weekdayDraft.includes(day);
                  return (
                    <button
                      aria-pressed={selected}
                      className={WEEKDAY_BUTTON_CLASS}
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
            <div className="mt-3 flex justify-end">
              <ApplyButton disabled={!validHourRange} label={messages.history.apply} onClick={applySecondaryFilters} testId="explore-filter-apply" />
            </div>
          </Ariakit.Popover>
        </Ariakit.PopoverProvider>
      </div>
    </>
  );
}