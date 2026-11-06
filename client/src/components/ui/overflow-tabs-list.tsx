import * as React from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface OverflowTabItem {
  value: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Optional count shown as a red badge (hidden when 0 or undefined) */
  badge?: number;
}

interface OverflowTabsListProps {
  items: OverflowTabItem[];
  activeValue: string;
  onSelect: (value: string) => void;
  className?: string;
}

// Shared sizing so the hidden measuring row matches the real triggers exactly
const ITEM_SIZE_CLASS = "px-2.5 py-1.5 text-xs sm:px-3 sm:py-1 sm:text-sm";
const ICON_CLASS = "w-4 h-4 mr-1.5 sm:mr-2 shrink-0";
const GAP_PX = 4; // matches gap-1
const LIST_PADDING_PX = 8; // matches p-1 (left + right)

const CountBadge = ({ count }: { count?: number }) =>
  count && count > 0 ? (
    <span className="absolute -top-1 -right-1 z-10 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center">
      {count}
    </span>
  ) : null;

/**
 * A tabs header that shows as many tabs as fit on one line and moves the
 * remainder into a "more" (⋯) popover. The active tab is always kept visible.
 */
const OverflowTabsList = ({
  items,
  activeValue,
  onSelect,
  className,
}: OverflowTabsListProps) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const moreMeasureRef = React.useRef<HTMLSpanElement>(null);
  const [visibleValues, setVisibleValues] = React.useState<Set<string> | null>(
    null,
  );
  const [moreOpen, setMoreOpen] = React.useState(false);

  const recalculate = React.useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const available = container.clientWidth - LIST_PADDING_PX;
    const widths = Array.from(measure.children).map(
      (el) => (el as HTMLElement).getBoundingClientRect().width,
    );

    // Not laid out yet (e.g. hidden or test environment): show everything
    if (available <= 0 || widths.every((w) => w === 0)) {
      setVisibleValues(null);
      return;
    }

    const total =
      widths.reduce((sum, w) => sum + w, 0) + GAP_PX * (widths.length - 1);
    if (total <= available) {
      setVisibleValues(null);
      return;
    }

    const moreWidth =
      (moreMeasureRef.current?.getBoundingClientRect().width ?? 32) + GAP_PX;
    let budget = available - moreWidth;
    const chosen = new Set<string>();

    // Reserve room for the active tab first so it never gets hidden
    const activeIndex = items.findIndex((item) => item.value === activeValue);
    if (activeIndex >= 0) {
      chosen.add(activeValue);
      budget -= widths[activeIndex];
    }

    for (let i = 0; i < items.length; i++) {
      if (i === activeIndex) continue;
      const needed = widths[i] + GAP_PX;
      if (needed > budget) break;
      chosen.add(items[i].value);
      budget -= needed;
    }

    setVisibleValues(chosen);
  }, [items, activeValue]);

  React.useLayoutEffect(() => {
    recalculate();
  }, [recalculate]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recalculate());
    observer.observe(container);
    return () => observer.disconnect();
  }, [recalculate]);

  const visibleItems = visibleValues
    ? items.filter((item) => visibleValues.has(item.value))
    : items;
  const overflowItems = visibleValues
    ? items.filter((item) => !visibleValues.has(item.value))
    : [];
  const overflowHasBadge = overflowItems.some(
    (item) => item.badge && item.badge > 0,
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full min-w-0", className)}
    >
      {/* Hidden row used only to measure each tab's natural width */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 whitespace-nowrap"
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <span
              key={item.value}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium",
                ITEM_SIZE_CLASS,
              )}
            >
              <Icon className={ICON_CLASS} />
              {item.label}
            </span>
          );
        })}
      </div>
      <span
        ref={moreMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 inline-flex items-center justify-center rounded-md px-2 py-1.5"
      >
        <MoreHorizontal className="w-4 h-4" />
      </span>

      <TabsList className="flex h-auto w-full flex-nowrap items-center justify-start gap-1 overflow-hidden p-1">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={cn("relative", ITEM_SIZE_CLASS)}
            >
              <Icon className={ICON_CLASS} />
              {item.label}
              <CountBadge count={item.badge} />
            </TabsTrigger>
          );
        })}

        {overflowItems.length > 0 && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="relative ml-auto inline-flex shrink-0 items-center justify-center rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`More tabs (${overflowItems.length})`}
                title="More tabs"
              >
                <MoreHorizontal className="w-4 h-4" />
                {overflowHasBadge && (
                  <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              <div role="menu" className="flex flex-col">
                {overflowItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => {
                        setMoreOpen(false);
                        onSelect(item.value);
                      }}
                      className={cn(
                        "flex w-full items-center rounded-sm px-2 py-2 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
                        item.value === activeValue && "bg-muted font-medium",
                      )}
                    >
                      <Icon className="w-4 h-4 mr-2 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && item.badge > 0 ? (
                        <span className="ml-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-xs text-white">
                          {item.badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </TabsList>
    </div>
  );
};

export { OverflowTabsList };
