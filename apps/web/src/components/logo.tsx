/** The envelope mark and the word mark. */
export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="inline-flex size-6 items-center justify-center rounded-[7px] bg-primary text-primary-foreground">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 8l9 6 9-6" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">envelopen</span>
    </span>
  );
}
