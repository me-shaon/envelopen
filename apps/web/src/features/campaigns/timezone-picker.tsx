import { ChevronDownIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { readStorage, writeStorage } from "@/lib/storage";
import { browserTimeZone, isTimeZone, timeZones } from "@/lib/timezone";
import { cn } from "@/lib/utils";

// A searchable list of IANA timezones (R8). It follows the ARIA combobox pattern: the
// input filters the list, the arrow keys move the highlight, Enter picks, and Escape
// closes the list. The list shows inline under the input, so the dialog never clips it.

/** A search shows at most this many matches. Typing more narrows it. */
const MAX_OPTIONS = 80;

function storageKey(workspaceId: number): string {
  return `envelopen.timezone.${workspaceId}`;
}

/** The last timezone picked in this workspace, or the browser zone. */
export function rememberedTimeZone(workspaceId: number): string {
  const stored = readStorage(storageKey(workspaceId));
  return stored && isTimeZone(stored) ? stored : browserTimeZone();
}

export function rememberTimeZone(workspaceId: number, zone: string): void {
  writeStorage(storageKey(workspaceId), zone);
}

function normalize(text: string): string {
  return text.toLowerCase().replaceAll("_", " ").trim();
}

export function TimeZonePicker({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  describedBy?: string;
}) {
  const zones = useMemo(() => timeZones(), []);
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${id}-list`;

  useEffect(() => {
    if (!open) setText(value);
  }, [open, value]);

  const matches = useMemo(() => {
    const query = normalize(text);
    // Right after the list opens, the input holds the current zone: show every zone.
    if (!query || text === value) return zones;
    return zones.filter((zone) => normalize(zone).includes(query)).slice(0, MAX_OPTIONS);
  }, [text, value, zones]);

  useEffect(() => {
    if (!open) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    option?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const openList = () => {
    const index = matches.indexOf(value);
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  };

  const pick = (zone: string) => {
    onChange(zone);
    setText(zone);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => Math.min(Math.max(index + step, 0), Math.max(matches.length - 1, 0)));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const zone = matches[active];
      if (zone) pick(zone);
    } else if (event.key === "Escape") {
      if (open) {
        // The dialog does not close: see onEscapeKeyDown in the confirm dialog.
        setOpen(false);
      }
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const onBlur = () => {
    // A typed exact name counts as a pick. Anything else goes back to the current zone.
    const exact = zones.find((zone) => normalize(zone) === normalize(text));
    if (exact && exact !== value) onChange(exact);
    setOpen(false);
  };

  const activeZone = open ? matches[active] : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeZone ? `${id}-option-${active}` : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          className="pr-8"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(event) => event.target.select()}
          onClick={() => {
            if (!open) openList();
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <ChevronDownIcon
          className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      {open && matches.length === 0 ? (
        <p role="status" className="m-0 px-1 text-xs text-muted-foreground">
          No timezone matches. Type a city, for example Dhaka.
        </p>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Timezones"
        hidden={!open || matches.length === 0}
        className="max-h-52 overflow-y-auto rounded-[9px] border border-input bg-card p-1"
      >
        {matches.map((zone, index) => (
          // The combobox input has the keyboard: the arrow keys and Enter pick an option.
          // biome-ignore lint/a11y/useKeyWithClickEvents: the input handles the keys.
          <div
            key={zone}
            id={`${id}-option-${index}`}
            data-index={index}
            role="option"
            tabIndex={-1}
            aria-selected={zone === value}
            className={cn(
              "flex min-h-8 max-sm:min-h-11 cursor-pointer items-center rounded-md px-2 text-[13px]",
              index === active && "bg-accent",
              zone === value && "font-medium",
            )}
            // Keep the focus in the input, so blur does not run before the pick.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => pick(zone)}
          >
            {zone}
          </div>
        ))}
      </div>
    </div>
  );
}
