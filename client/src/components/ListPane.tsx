import {
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

import { Input } from "./ui/input";
import { useState, useMemo, useRef } from "react";

type ListPaneProps<T> = {
  items: T[];
  listItems: () => void;
  clearItems: () => void;
  setSelectedItem: (item: T) => void;
  renderItem: (item: T) => React.ReactNode;
  title: string;
  buttonText: string;
  isButtonDisabled?: boolean;
  headerActions?: React.ReactNode;
  itemStatus?: Map<number, "success" | "error" | "running">;
  onStatusClick?: (originalIndex: number) => void;
};

const ListPane = <T extends object>({
  items,
  listItems,
  clearItems: _clearItems,
  setSelectedItem,
  renderItem,
  title,
  buttonText,
  isButtonDisabled,
  headerActions,
  itemStatus,
  onStatusClick,
}: ListPaneProps<T>) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;

    return items.filter((item) => {
      const searchableText = [
        (item as { name?: string }).name || "",
        (item as { description?: string }).description || "",
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(searchQuery.toLowerCase());
    });
  }, [items, searchQuery]);

  const handleSearchClick = () => {
    setIsSearchExpanded(true);
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  };

  const handleSearchBlur = () => {
    if (!searchQuery.trim()) {
      setIsSearchExpanded(false);
    }
  };

  return (
    <div className="min-w-0 bg-card border border-border rounded-lg shadow">
      <div className="p-4 border-b border-gray-200 dark:border-border">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold dark:text-white flex-shrink-0">
            {title}
          </h3>
          <div className="flex items-center justify-end min-w-0 flex-1 gap-1">
            {headerActions}
            <button
              name="list"
              aria-label={buttonText}
              title={buttonText}
              onClick={listItems}
              disabled={isButtonDisabled}
              className="p-2 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-300 ease-in-out disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-4 h-4 text-muted-foreground" />
            </button>
            {!isSearchExpanded ? (
              <button
                name="search"
                aria-label="Search"
                onClick={handleSearchClick}
                className="p-2 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-300 ease-in-out"
              >
                <Search className="w-4 h-4 text-muted-foreground" />
              </button>
            ) : (
              <div className="flex items-center w-full max-w-xs">
                <div className="relative w-full">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none z-10" />
                  <Input
                    ref={searchInputRef}
                    name="search"
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onBlur={handleSearchBlur}
                    className="pl-10 w-full transition-all duration-300 ease-in-out"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="p-4">
        <div className="space-y-2 overflow-y-auto max-h-96">
          {filteredItems.map((item, index) => {
            const originalIndex = items.indexOf(item);
            const status = itemStatus?.get(originalIndex);
            return (
              <div
                key={index}
                className="flex items-center py-2 px-4 rounded hover:bg-gray-50 dark:hover:bg-secondary cursor-pointer gap-2"
                onClick={() => setSelectedItem(item)}
              >
                {status === "success" && (
                  <button
                    className="flex-shrink-0 p-0.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                    title="View run details"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatusClick?.(originalIndex);
                    }}
                  >
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                  </button>
                )}
                {status === "error" && (
                  <button
                    className="flex-shrink-0 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                    title="View run details"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatusClick?.(originalIndex);
                    }}
                  >
                    <XCircle className="w-5 h-5 text-red-500" />
                  </button>
                )}
                {status === "running" && (
                  <Loader2 className="w-5 h-5 mr-1 text-blue-500 animate-spin flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">{renderItem(item)}</div>
              </div>
            );
          })}
          {filteredItems.length === 0 && searchQuery && items.length > 0 && (
            <div className="text-center py-4 text-muted-foreground">
              No items found matching &quot;{searchQuery}&quot;
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ListPane;
