"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, CalendarDays, Check, Filter } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

function hourRangeLabel(hour: number): string {
  const next = (hour + 1) % 24;
  return `${String(hour).padStart(2, "0")}h–${String(next).padStart(2, "0")}h`;
}

function weekdayLabel(value: string, messages: Messages): string {
  switch (value) {
    case "1,2,3,4,5": return messages.history.weekdays;
    case "0,6": return messages.history.weekend;
    case "0": return messages.history.sunday;
    case "1": return messages.history.monday;
    case "2": return messages.history.tuesday;
    case "3": return messages.history.wednesday;
    case "4": return messages.history.thursday;
    case "5": return messages.history.friday;
    case "6": return messages.history.saturday;
    default: return messages.history.allDays;
  }
}

function activeFiltersLabel(filters: HistoryFilters, messages: Messages): string {
  const labels: string[] = [];
  if (filters.weekdays.length > 0) labels.push(weekdayLabel(filters.weekdays.join(","), messages));
  if (filters.hour !== null) labels.push(hourRangeLabel(filters.hour));
  return labels.length === 0 ? messages.history.noActiveFilters : labels.join(" · ");
}

function ApplyButton({ label, disabled = false, onClick, testId }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void; readonly testId: string }) {
  return (
    <button
      aria-label={label}
      className="grid size-11 shrink-0 place-items-center rounded-md bg-primary text-background transition-[transform,opacity] duration-100 hover:opacity-90 active:scale-90 disabled:cursor-not-allowed disabled:opacity-35"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Check className="size-4" />
    </button>
  );
}

const POPOVER_CLASS = "z-[80] w-[60vw] max-w-[48rem] min-w-[20rem] rounded-xl border border-border bg-surface-strong p-4 text-foreground shadow-[var(--shadow-float)] outline-none max-sm:w-[calc(100vw-1rem)] max-sm:min-w-0";

export function HistoryFiltersForm({ filters, messages }: { readonly filters: HistoryFilters; readonly messages: Messages }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const weekdayKey = filters.weekdays.join(",");
  const [dateOpen, setDateOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(filters.from);
  const [dateTo, setDateTo] = useState(filters.to);
  const [weekdayDraft, setWeekdayDraft] = useState(weekdayKey);
  const [hourDraft, setHourDraft] = useState(filters.hour === null ? "" : String(filters.hour));

  const navigate = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete("direction");
    const query = params.toString();
    router.push(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const applyDates = (from: string, to: string) => {
    setDateOpen(false);
    navigate((params) => {
      params.set("from", from);
      params.set("to", to);
    });
  };

  const applySecondaryFilters = () => {
    setFilterOpen(false);
    navigate((params) => {
      if (weekdayDraft === "") params.delete("weekdays");
      else params.set("weekdays", weekdayDraft);
      if (hourDraft === "") params.delete("hour");
      else params.set("hour", hourDraft);
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
      setWeekdayDraft(weekdayKey);
      setHourDraft(filters.hour === null ? "" : String(filters.hour));
    }
    setFilterOpen(open);
  };

  const selectedDays = calendarDaysInclusive(dateFrom, dateTo);
  const validDateRange = Number.isFinite(selectedDays) && selectedDays >= 1 && selectedDays <= MAX_HISTORY_RANGE_DAYS;
  const presets: readonly { readonly id: DatePreset; readonly label: string }[] = [
    { id: "today", label: messages.history.today },
    { id: "yesterday", label: messages.history.yesterday },
    { id: "last7", label: messages.history.last7Days },
    { id: "lastWeek", label: messages.history.lastWeek },
    { id: "thisMonth", label: messages.history.thisMonth },
    { id: "last30", label: messages.history.last30Days },
    { id: "thisYear", label: messages.history.thisYear },
  ];

  return (
    <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,.65fr)] gap-2" data-testid="explore-filter-bar">
      <Ariakit.PopoverProvider open={dateOpen} setOpen={setDatePopoverOpen}>
        <Ariakit.PopoverDisclosure
          aria-label={messages.history.dateRange}
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-strong px-3 text-sm font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75"
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-end gap-2">
            <label className="grid min-w-0 gap-1 text-xs font-bold text-muted">
              {messages.history.from}
              <input className="min-h-11 min-w-0 rounded-md border border-border bg-surface px-2 text-sm text-foreground" onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
            </label>
            <ArrowRight className="mb-3 size-4 shrink-0 text-muted" aria-hidden="true" />
            <label className="grid min-w-0 gap-1 text-xs font-bold text-muted">
              {messages.history.to}
              <input className="min-h-11 min-w-0 rounded-md border border-border bg-surface px-2 text-sm text-foreground" onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
            </label>
            <ApplyButton disabled={!validDateRange} label={messages.history.apply} onClick={() => applyDates(dateFrom, dateTo)} testId="explore-date-apply" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                className="rounded-full border border-border bg-surface px-3 py-2 text-xs font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-95 active:opacity-75"
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
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-strong px-3 text-sm font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75"
          data-testid="explore-secondary-filter"
          type="button"
        >
          <Filter className="size-4 shrink-0 text-[var(--landing-highlight)]" />
          <span className="min-w-0 truncate">{activeFiltersLabel(filters, messages)}</span>
        </Ariakit.PopoverDisclosure>
        <Ariakit.Popover className={POPOVER_CLASS} data-testid="explore-filter-popover" gutter={8} portal>
          <Ariakit.PopoverHeading className="sr-only">{messages.history.filters}</Ariakit.PopoverHeading>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
            <label className="grid min-w-0 gap-1 text-xs font-bold text-muted">
              {messages.history.weekdayFilter}
              <select className="min-h-11 min-w-0 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground" onChange={(event) => setWeekdayDraft(event.target.value)} value={weekdayDraft}>
                <option value="">{messages.history.allDays}</option>
                <option value="1,2,3,4,5">{messages.history.weekdays}</option>
                <option value="0,6">{messages.history.weekend}</option>
                <option value="1">{messages.history.monday}</option>
                <option value="2">{messages.history.tuesday}</option>
                <option value="3">{messages.history.wednesday}</option>
                <option value="4">{messages.history.thursday}</option>
                <option value="5">{messages.history.friday}</option>
                <option value="6">{messages.history.saturday}</option>
                <option value="0">{messages.history.sunday}</option>
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-xs font-bold text-muted">
              {messages.history.timeSlot}
              <select className="min-h-11 min-w-0 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground" onChange={(event) => setHourDraft(event.target.value)} value={hourDraft}>
                <option value="">{messages.history.allTimeSlots}</option>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourRangeLabel(hour)}</option>)}
              </select>
            </label>
            <ApplyButton label={messages.history.apply} onClick={applySecondaryFilters} testId="explore-filter-apply" />
          </div>
        </Ariakit.Popover>
      </Ariakit.PopoverProvider>
    </div>
  );
}
