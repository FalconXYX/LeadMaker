/** The LeadMaker mark: a roof line on a cool-sky tile. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--c-accent)" />
      <path d="M7 18.5 16 10l9 8.5" fill="none" stroke="var(--c-accent-fg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 22h9" stroke="var(--c-accent-fg)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
