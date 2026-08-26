"use client";

import { useId } from "react";
import type { ReactNode } from "react";

type SegmentedRadioValue = string | number;

interface SegmentedRadioOption<T extends SegmentedRadioValue> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

export function SegmentedRadio<T extends SegmentedRadioValue>({
  label,
  name,
  value,
  options,
  onChange,
  compact = false,
  testId,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: T;
  readonly options: readonly SegmentedRadioOption<T>[];
  readonly onChange: (value: T) => void;
  readonly compact?: boolean;
  readonly testId?: string;
}) {
  const id = useId();
  const groupName = `${name}-${id}`;

  return (
    <div
      aria-label={label}
      className={`grid grid-cols-2 overflow-hidden border border-border bg-muted-soft ${compact ? "rounded-lg p-0.5" : "rounded-xl p-1"}`}
      data-testid={testId}
      role="radiogroup"
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label className="group relative min-w-0 cursor-pointer select-none" key={option.value}>
            <input
              checked={checked}
              className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
              name={groupName}
              onChange={() => onChange(option.value)}
              type="radio"
              value={String(option.value)}
            />
            <span
              className={`flex min-w-0 items-center justify-center font-bold transition-[background-color,color,box-shadow,transform,opacity] group-active:scale-[.98] group-active:opacity-75 peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-inset ${compact ? "min-h-7 gap-1 rounded-md px-1.5 text-[7px]" : "min-h-10 gap-2 rounded-lg px-3 text-sm"} ${checked ? "bg-surface-strong text-primary shadow-sm" : "text-muted group-hover:text-foreground"}`}
            >
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
