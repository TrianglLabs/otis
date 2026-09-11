import { memo, useMemo } from "react"
import type { TranscriptEntry } from "../../../../app/transcript.js"
import { useDesktop, useDesktopSelector } from "../../runtime.js"
import { Composer } from "./Composer.js"
import { EmptyState } from "./EmptyState.js"
import { PermissionCard } from "./PermissionCard.js"
import { TranscriptList } from "./TranscriptList.js"

const emptyEntries: TranscriptEntry[] = []

/** The transcript and composer subscribe independently, so streamed text doesn't redraw the input. */
export const ConversationView = memo(function ConversationView({ installing = false }: { installing?: boolean }) {
  const { api } = useDesktop()
  const state = useDesktopSelector((snapshot) => ({
    entries: snapshot?.entries ?? emptyEntries,
    busy: snapshot?.busy ?? false,
    thinkingVisible: snapshot?.thinkingVisible ?? false,
    permission: snapshot?.permission ?? null,
    sessionKey: `${snapshot?.workspace.path ?? ""}:${snapshot?.session?.id ?? ""}`,
  }))
  const footer = useMemo(
    () =>
      state.permission ? (
        <PermissionCard
          permission={state.permission}
          onRespond={(id, allow) => void api.respondToPermission(id, allow)}
        />
      ) : null,
    [state.permission, api],
  )

  return (
    <div className="conversation">
      {state.entries.length === 0 && !state.permission ? (
        <EmptyState />
      ) : (
        <TranscriptList
          key={state.sessionKey}
          entries={state.entries}
          busy={state.busy}
          thinkingVisible={state.thinkingVisible}
          footer={footer}
        />
      )}
      <div className="composerWrap">
        <Composer installing={installing} />
      </div>
    </div>
  )
})
