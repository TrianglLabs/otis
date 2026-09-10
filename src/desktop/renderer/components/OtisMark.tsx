/** Shared cube artwork: muted faces and an O face in the current theme's accent. */
export function OtisMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 136" fill="currentColor" role="img" aria-label="Otis">
      <title>Otis</title>
      <g transform="matrix(.866025 .5 -.866025 .5 60 8)" opacity=".7">
        <rect x="2" y="2" width="16" height="16" rx="2" />
        <rect x="22" y="2" width="16" height="16" rx="2" />
        <rect x="42" y="2" width="16" height="16" rx="2" />
        <rect x="2" y="22" width="16" height="16" rx="2" />
        <rect x="22" y="22" width="16" height="16" rx="2" />
        <rect x="42" y="22" width="16" height="16" rx="2" />
        <rect x="2" y="42" width="16" height="16" rx="2" />
        <rect x="22" y="42" width="16" height="16" rx="2" />
        <rect x="42" y="42" width="16" height="16" rx="2" />
      </g>
      <g transform="matrix(.866025 .5 0 1 8.0385 38)" opacity=".45">
        <rect x="2" y="2" width="16" height="16" rx="2" />
        <rect x="22" y="2" width="16" height="16" rx="2" />
        <rect x="42" y="2" width="16" height="16" rx="2" />
        <rect x="2" y="22" width="16" height="16" rx="2" />
        <rect x="22" y="22" width="16" height="16" rx="2" />
        <rect x="42" y="22" width="16" height="16" rx="2" />
        <rect x="2" y="42" width="16" height="16" rx="2" />
        <rect x="22" y="42" width="16" height="16" rx="2" />
        <rect x="42" y="42" width="16" height="16" rx="2" />
      </g>
      <g transform="matrix(.866025 -.5 0 1 60 68)" fill="var(--accent, currentColor)">
        <rect x="2" y="2" width="16" height="16" rx="2" />
        <rect x="22" y="2" width="16" height="16" rx="2" />
        <rect x="42" y="2" width="16" height="16" rx="2" />
        <rect x="2" y="22" width="16" height="16" rx="2" />
        <rect x="42" y="22" width="16" height="16" rx="2" />
        <rect x="2" y="42" width="16" height="16" rx="2" />
        <rect x="22" y="42" width="16" height="16" rx="2" />
        <rect x="42" y="42" width="16" height="16" rx="2" />
      </g>
    </svg>
  )
}
