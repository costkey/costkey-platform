import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { Link } from "react-router-dom";
import "../pages/Users.css";

/**
 * A long id with its middle cut: "3f2a9c…e81b". Short ids, where cutting
 * would save almost nothing, come back whole.
 */
// eslint-disable-next-line react-refresh/only-export-components -- a pure helper kept beside the one component that uses it.
export function truncateMiddle(id: string, head = 6, tail = 4): string {
  const chars = Array.from(id);
  if (chars.length <= head + tail + 3) return id;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/**
 * An end user's id: cut in the middle when long, the full id on hover, a copy
 * button, and a link when `to` is given. `length` is how many characters stay
 * visible (10 by default: six at the start, four at the end).
 */
export function UserId({ id, to, length = 10, linkClassName = "", className = "" }: { id: string; to?: string; length?: number; linkClassName?: string; className?: string }) {
  const tail = Math.min(4, Math.floor(length / 2));
  const shown = truncateMiddle(id, Math.max(1, length - tail), tail);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // No clipboard (insecure context or denied): the id is still in the title.
    }
  };
  return <span className={`ck-users-id ${className}`}>
    {to
      ? <Link className={`ck-users-id-text ${linkClassName}`} to={to} title={id}>{shown}</Link>
      : <span className="ck-users-id-text" title={id}>{shown}</span>}
    <button className="ck-users-copy" type="button" aria-label="Copy user id" title={copied ? "Copied" : "Copy user id"} onClick={(event) => void copy(event)}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  </span>;
}
