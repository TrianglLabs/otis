import {
  Box,
  CalendarDays,
  Clock,
  Cloud,
  Flame,
  FolderOpen,
  Frame,
  Laptop,
  Lock,
  type LucideIcon,
  Moon,
  Puzzle,
  Rocket,
  Sunrise,
} from "lucide-react"
import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import type { AchievementId } from "../../../../local/stats.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import type { MessageKey } from "../../i18n/messages/en.js"
import { useDesktop, useDesktopState } from "../../runtime.js"

/**
 * In display order. Firsts are earned once; `repeats` ones tally each time; `secret` ones hide
 * until earned.
 */
const ACHIEVEMENTS: Record<AchievementId, { icon: LucideIcon; secret?: true; repeats?: true }> = {
  "first-session": { icon: Rocket },
  "local-model": { icon: Laptop },
  "hosted-model": { icon: Cloud },
  coworker: { icon: Box },
  document: { icon: Frame },
  skill: { icon: Puzzle },
  "deep-work": { icon: Clock, repeats: true },
  "week-streak": { icon: Flame, repeats: true },
  "night-owl": { icon: Moon, secret: true, repeats: true },
  "early-bird": { icon: Sunrise, secret: true, repeats: true },
  "ten-workspaces": { icon: FolderOpen },
  "thirty-days": { icon: CalendarDays },
}
const ACHIEVEMENT_IDS = Object.keys(ACHIEVEMENTS) as AchievementId[]

const title = (id: AchievementId) => `achievements.${id}` as MessageKey
const detail = (id: AchievementId) => `achievements.${id}.detail` as MessageKey

/** The pointer is the light: its position over the card, 0..1 each way, tilts the medal to it. */
function lightMedal(event: PointerEvent<HTMLDivElement>) {
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty("--px", String((event.clientX - box.left) / box.width))
  event.currentTarget.style.setProperty("--py", String((event.clientY - box.top) / box.height))
}

function restMedal(event: PointerEvent<HTMLDivElement>) {
  event.currentTarget.style.removeProperty("--px")
  event.currentTarget.style.removeProperty("--py")
}

/** The Achievements settings tab: every medal, earned ones dated, fresh ones marked new. */
export function AchievementsTab() {
  const { api } = useDesktop()
  const { locale, t } = useI18n()
  const state = useDesktopState("stats", "freshAchievements")
  const earned = state?.stats?.achievements ?? {}
  const fresh = state?.freshAchievements ?? []
  // Leaving the tab counts as having looked: the "New" marks and the dots clear then.
  const unseen = useRef(false)
  unseen.current = fresh.length > 0
  useEffect(
    () => () => {
      if (unseen.current) void api.markAchievementsSeen()
    },
    [api],
  )
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  return (
    <div className="achievements">
      {ACHIEVEMENT_IDS.map((id) => {
        const { icon, secret, repeats } = ACHIEVEMENTS[id]
        const got = earned[id]
        const hidden = secret && !got
        const isNew = fresh.includes(id)
        return (
          <div
            key={id}
            className="achievement"
            data-earned={got ? "true" : undefined}
            data-new={isNew ? "true" : undefined}
            onPointerMove={lightMedal}
            onPointerLeave={restMedal}
          >
            <span className="achievement-badge">
              {isNew ? <span className="achievement-new">{t("achievements.new")}</span> : null}
              {repeats && got && got.count > 1 ? (
                <span className="achievement-count">×{got.count}</span>
              ) : null}
              <Icon icon={hidden ? Lock : icon} size={32} strokeWidth={1.75} />
            </span>
            <span className="achievement-title">
              {hidden ? t("achievements.hidden") : t(title(id))}
            </span>
            <span className="achievement-detail">
              {hidden ? t("achievements.hiddenHint") : t(detail(id))}
            </span>
            <span className="achievement-date">
              {got ? date.format(new Date(got.at)) : t("achievements.locked")}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Banners for achievements earned while the app runs, shown one at a time in the order earned;
 * the ones waiting peek out behind the front card. The first status that carries stats is history
 * and never announced; each id appearing after it gets a banner.
 */
export function UnlockBanners({ onOpen }: { onOpen: () => void }) {
  const state = useDesktopState("stats", "freshAchievements")
  const known = useRef<AchievementId[] | undefined>(undefined)
  const [unlocks, setUnlocks] = useState<AchievementId[]>([])
  useEffect(() => {
    if (!state?.stats) return
    const seen = known.current
    known.current = state.freshAchievements
    if (!seen) return
    const added = state.freshAchievements.filter((id) => !seen.includes(id))
    if (added.length) setUnlocks((list) => [...list, ...added])
  }, [state])
  // Only the front card retires itself, so the queue's head is always the one leaving.
  const dismiss = useCallback(() => setUnlocks((list) => list.slice(1)), [])
  // The tab shows everything, so opening it retires the whole queue.
  const open = () => {
    setUnlocks([])
    onOpen()
  }
  if (unlocks.length === 0) return null
  return (
    <div className="unlockStack">
      {unlocks.slice(0, 3).map((id, depth) => (
        <UnlockBanner key={id} id={id} depth={depth} onDone={dismiss} onOpen={open} />
      ))}
    </div>
  )
}

function UnlockBanner({
  id,
  depth,
  onDone,
  onOpen,
}: {
  id: AchievementId
  depth: number
  onDone: () => void
  onOpen: () => void
}) {
  const { t } = useI18n()
  const { icon, secret } = ACHIEVEMENTS[id]
  const [leaving, setLeaving] = useState(false)
  // Only the front card is on the clock; the 300ms between them is its opacity transition.
  useEffect(() => {
    if (depth !== 0) return
    const fade = setTimeout(() => setLeaving(true), 3700)
    const gone = setTimeout(onDone, 4000)
    return () => {
      clearTimeout(fade)
      clearTimeout(gone)
    }
  }, [depth, onDone])
  return (
    <button
      type="button"
      className="unlockCard noDrag"
      data-leaving={leaving ? "true" : undefined}
      style={{ "--depth": depth } as CSSProperties}
      onClick={onOpen}
    >
      <span className="unlockCard-medal">
        <svg className="unlockCard-ring" viewBox="0 0 64 64" role="presentation">
          <circle cx="32" cy="32" r="29" pathLength={100} />
        </svg>
        <Icon icon={icon} size={24} strokeWidth={1.75} />
      </span>
      <span className="unlockCard-text">
        <span className="unlockCard-eyebrow">
          {t(secret ? "achievements.secretFound" : "achievements.unlocked")}
        </span>
        <span className="unlockCard-title">{t(title(id))}</span>
        <span className="unlockCard-detail">{t(detail(id))}</span>
      </span>
    </button>
  )
}
