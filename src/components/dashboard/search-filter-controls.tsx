"use client";

import { useId } from "react";
import { Filter, Search, X } from "@/components/icons";
import { Button } from "@/components/ui/button-clean";
import { FilterMenu, type FilterGroup, type FilterValue } from "@/components/ui/filter-menu-clean";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import "./search-filter-controls.css";

/** Shared search and multi-select filters; the page owns filtering and drafts. */
export function SearchFilterControls({
  query,
  onQueryChange,
  searchLabel,
  clearSearchLabel,
  groups,
  filters,
  onFiltersChange,
  filterTitle,
  filterLabel = "Filter by role",
  emptyFilterLabel = "All roles",
  activeFilterLabel = "Role",
  disabled = false,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  clearSearchLabel: string;
  groups: FilterGroup[];
  filters: FilterValue;
  onFiltersChange: (filters: FilterValue) => void;
  filterTitle: string;
  filterLabel?: string;
  emptyFilterLabel?: string;
  activeFilterLabel?: string;
  disabled?: boolean;
}) {
  const searchId = useId();
  const selectedCount = groups.reduce((sum, group) => sum + group.options.filter(
    (option) => filters[group.id]?.includes(option.id)
  ).length, 0);

  return (
    <div className="search-filter-controls">
      <InputGroup className="search-filter-search">
        <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
        <InputGroupInput id={searchId} type="search" name="search" placeholder={`${searchLabel}…`}
          value={query} onChange={(event) => onQueryChange(event.target.value)} />
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        {query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label={clearSearchLabel} onClick={() => onQueryChange("")}>
              <X aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <Popover>
        <PopoverTrigger render={<Button size="lg" variant="secondary" className="search-filter-trigger"
          icon={<Filter />} aria-label={filterLabel} disabled={disabled} />}>
          {selectedCount ? `${activeFilterLabel} · ${selectedCount}` : emptyFilterLabel}
        </PopoverTrigger>
        <PopoverContent unstyled align="end" className="search-filter-popover">
          <PopoverTitle className="sr-only">{filterTitle}</PopoverTitle>
          <FilterMenu title="Filters" groups={groups} value={filters}
            onChange={(value) => { if (!disabled) onFiltersChange(value); }} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
