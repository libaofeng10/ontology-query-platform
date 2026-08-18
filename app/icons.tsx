import type { SVGProps } from "react";

export type IconName =
  | "spark"
  | "database"
  | "message"
  | "book"
  | "target"
  | "shield"
  | "search"
  | "send"
  | "download"
  | "copy"
  | "check"
  | "clock"
  | "table"
  | "chart"
  | "link"
  | "arrow"
  | "close"
  | "menu"
  | "plus"
  | "trash"
  | "refresh"
  | "graph";

const PATHS: Record<IconName, React.ReactNode> = {
  spark: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z"/></>,
  database: <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>,
  message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></>,
  arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
  refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></>,
  graph: <><circle cx="5" cy="12" r="2.5"/><circle cx="17.5" cy="5.5" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m7.2 10.8 8-4.1M7.4 13.1l8.3 3.8M17.7 8v7.5"/></>,
};

export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {PATHS[name]}
    </svg>
  );
}
