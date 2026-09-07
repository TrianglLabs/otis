import { ArrowDown } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { useScrollbarFlash } from "../../useScrollbarFlash.js"
import { Composer } from "./Composer.js"
import { EmptyState } from "./EmptyState.js"
import { EntryView } from "./entries.js"
import { PermissionCard } from "./PermissionCard.js"
import { visibleEntries } from "./visible-entries.js"

const BOTTOM_THRESHOLD_PX = 32

/**
 * The conversation column: transcript, pending approval, composer. Follows new content while the user is at the
 * bottom and preserves their reading position once they scroll up. Text stays selectable at all times.
 */
export function ConversationView() {
  const { api } = useDesktop()
  const state = useDesktopState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const scrollbar = useScrollbarFlash()

  const entries = visibleEntries(state?.entries ?? [], state?.thinkingVisible ?? false)
  const permission = state?.permission ?? null

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && atBottom) element.scrollTop = element.scrollHeight
  }, [entries, permission, atBottom])

  const onScroll = () => {
    scrollbar.onScroll()
    const element = scrollRef.current
    if (!element) return
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX)
  }

  const jumpToLatest = () => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    setAtBottom(true)
  }

  return (
    <div className="conversation">
      {entries.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          className={`transcriptScroll${scrollbar.scrolling ? " scrolling" : ""}`}
          ref={scrollRef}
          onScroll={onScroll}
        >
          <div className="transcript">
            {entries.map((entry, index) => (
              <EntryView key={entry.id} entry={entry} active={isActiveEntry(entries, index, state?.busy ?? false)} />
            ))}
            {permission ? (
              <PermissionCard
                permission={permission}
                onRespond={(id, allow) => void api.respondToPermission(id, allow)}
              />
            ) : null}
          </div>
        </div>
      )}
      {!atBottom && entries.length > 0 ? (
        <button type="button" className="jumpToLatest" onClick={jumpToLatest}>
          <Icon icon={ArrowDown} size={12} /> Latest
        </button>
      ) : null}
      <div className="composerWrap">
        <Composer />
      </div>
    </div>
  )
}

/** A tool card is active while it is the latest entry and the agent is still working. */
function isActiveEntry(entries: TranscriptEntry[], index: number, busy: boolean) {
  return busy && index === entries.length - 1
}
