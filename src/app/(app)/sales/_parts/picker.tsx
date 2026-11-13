"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Choice = { id: string; label: string; sub?: string };

/** Asks the server for the customers or items that match what was typed. */
export async function lookUp(what: "customers" | "items", typed: string, signal?: AbortSignal): Promise<Choice[]> {
  const response = await fetch(`/sales/lookup?what=${what}&q=${encodeURIComponent(typed)}`, { signal, cache: "no-store" });
  if (!response.ok) return [];
  const body = (await response.json()) as { choices?: Choice[] };
  return body.choices ?? [];
}

type Props = {
  what: "customers" | "items";
  /** Read by screen readers and by the tests: "Customer", or "Item, line 2". */
  label: string;
  value: Choice | null;
  onPick: (choice: Choice | null) => void;
  placeholder?: string;
  id?: string;
  className?: string;
};

/**
 * A box that finds a customer or an item as it is typed. The keyboard is enough: type part of
 * the code or name, move with the arrow keys, and Tab or Enter takes the highlighted match. A
 * code typed in full and left with Tab is taken without looking at the list at all.
 */
export function Picker({ what, label, value, onPick, placeholder, id, className }: Props) {
  const listId = useId();
  const [text, setText] = useState(value?.label ?? "");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [unknown, setUnknown] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the box shows follows the chosen value when the form sets it from outside.
  const shown = useRef(value?.id ?? null);
  useEffect(() => {
    if ((value?.id ?? null) !== shown.current) {
      shown.current = value?.id ?? null;
      setText(value?.label ?? "");
    }
  }, [value]);
  useEffect(
    () => () => {
      pending.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const take = (choice: Choice) => {
    shown.current = choice.id;
    setText(choice.label);
    setOpen(false);
    setUnknown(false);
    onPick(choice);
  };

  const search = (typed: string) => {
    if (timer.current) clearTimeout(timer.current);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    timer.current = setTimeout(() => {
      lookUp(what, typed, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setChoices(found);
          setActive(0);
          setOpen(true);
        })
        .catch(() => {});
    }, 150);
  };

  /** Leaving the box with something typed and nothing chosen: take it if it names exactly one thing. */
  const settle = async () => {
    const typed = text.trim();
    if (shown.current !== null || typed === "") return;
    if (timer.current) clearTimeout(timer.current);
    pending.current?.abort();
    const found = await lookUp(what, typed).catch(() => []);
    const exact = found.find((choice) => choice.label.toLowerCase() === typed.toLowerCase() || choice.sub?.toLowerCase() === typed.toLowerCase());
    const taken = exact ?? (found.length === 1 ? found[0] : null);
    if (taken) take(taken);
    else setUnknown(true);
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={unknown || undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setUnknown(false);
          if (value !== null) {
            shown.current = null;
            onPick(null);
          }
          // The list on screen belongs to what was typed before: it is put away until the
          // matches for the new text arrive, so Tab or Enter never takes a stale match.
          setOpen(false);
          setChoices([]);
          if (event.target.value.trim() !== "") search(event.target.value);
        }}
        onFocus={() => {
          if (value === null && text.trim() !== "") search(text);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, choices.length - 1));
          } else if (event.key === "ArrowUp" && open) {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            // Enter chooses; it never sends the form from here.
            event.preventDefault();
            if (open && choices[active]) take(choices[active]);
            else void settle();
          } else if (event.key === "Tab" && open && choices[active] && value === null) {
            take(choices[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        onBlur={() => {
          setOpen(false);
          void settle();
        }}
      />
      {open && value === null ? (
        <ul id={listId} role="listbox" aria-label={`${label}: matches`} className="absolute z-20 mt-1 max-h-64 w-max max-w-[min(28rem,90vw)] min-w-full overflow-auto rounded-lg border bg-card py-1 text-sm shadow-md">
          {choices.length === 0 ? (
            <li className="px-3 py-1.5 text-muted-foreground">Nothing matches.</li>
          ) : (
            choices.map((choice, index) => (
              <li
                key={choice.id}
                role="option"
                aria-selected={index === active}
                // Pressing, not clicking: the box must not lose focus (and close the list) first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(choice);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn("cursor-pointer px-3 py-1.5", index === active && "bg-accent text-accent-foreground")}
              >
                <span className="font-medium">{choice.label}</span>
                {choice.sub ? <span className="ml-2 text-muted-foreground">{choice.sub}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
