import { useEffect, useRef, useState } from "react"
import type { LocalStats } from "../../../../local/stats.js"
import logoUrl from "../../assets/logo.svg"
import { useDesktopState } from "../../runtime.js"

/**
 * The home screen: brand mark and the usage strip. When inference is not usable it also carries the guidance to
 * get running — the only actionable state on an empty screen.
 */
export function EmptyState() {
  const state = useDesktopState()
  if (!state) return null

  return (
    <div className="home">
      <img className="home-logo" src={logoUrl} alt="Otis" draggable={false} />
      {state.stats && state.stats.sessionCount > 0 ? <StatsStrip stats={state.stats} /> : null}
      {state.modelState === "starting" ? (
        <p className="home-setup">The selected model is starting…</p>
      ) : state.modelState === "failed" ? (
        <div className="home-setup">
          <p>The selected model could not start{state.modelError ? `: ${state.modelError}` : "."}</p>
          <p className="home-setupHint">Pick a different model from the model menu in the composer.</p>
        </div>
      ) : state.modelState === "unconfigured" ? (
        <div className="home-setup">
          <p>No model is configured yet.</p>
          <p className="home-setupHint">
            Run <code>otis</code> in this workspace once to set up inference — the desktop app uses the same
            configuration and sessions.
          </p>
        </div>
      ) : null}
    </div>
  )
}

const STAT_DEFS: { pick: (stats: LocalStats) => number; label: string; format: (value: number) => string }[] = [
  { pick: (stats) => stats.streak, label: "day streak", format: formatPlain },
  { pick: (stats) => stats.totalTokens, label: "tokens", format: formatCompact },
  { pick: (stats) => stats.avgTokensPerSession, label: "tokens / session", format: formatCompact },
  { pick: (stats) => stats.avgSessionSeconds, label: "time / session", format: formatSeconds },
]

function StatsStrip({ stats }: { stats: LocalStats }) {
  const targets = STAT_DEFS.map((def) => def.pick(stats))
  const values = useCountUp(targets)
  return (
    <div className="homeStats">
      {STAT_DEFS.map((def, index) => (
        <div key={def.label} className="homeStats-item">
          <span className="homeStats-value">{def.format(values[index] ?? 0)}</span>
          <span className="homeStats-label">{def.label}</span>
        </div>
      ))}
    </div>
  )
}

const COUNT_UP_MS = 900
const COUNT_UP_STAGGER_MS = 70

/** Animates each target from 0 with a staggered ease-out; skipped entirely under reduced motion. */
function useCountUp(targets: number[]): number[] {
  const [values, setValues] = useState(targets)
  const key = targets.join(",")
  const previousKey = useRef("")

  useEffect(() => {
    // New data (e.g. after a turn) snaps to the real numbers; the count-up plays once per home display.
    const animate = previousKey.current !== key
    previousKey.current = key
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!animate || reduceMotion || targets.every((target) => target === 0)) {
      setValues(targets)
      return
    }
    const startedAt = performance.now()
    const total = COUNT_UP_MS + (targets.length - 1) * COUNT_UP_STAGGER_MS
    let frame = 0
    const tick = (now: number) => {
      const elapsed = now - startedAt
      setValues(
        targets.map((target, index) => {
          const progress = Math.min(1, Math.max(0, (elapsed - index * COUNT_UP_STAGGER_MS) / COUNT_UP_MS))
          return Math.round(target * (1 - (1 - progress) ** 3))
        }),
      )
      if (elapsed < total) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // `targets` is derived from `key`; re-run only when the values actually change.
  }, [key])

  return values
}

function formatPlain(value: number): string {
  return value.toLocaleString()
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function formatSeconds(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds)}s`
}
