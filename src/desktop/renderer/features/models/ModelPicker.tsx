import { Check, Download, Loader2, Star, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import { IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { useScrollbarFlash } from "../../useScrollbarFlash.js"
import { isPickerRowSelectable, mergeModelLoad, pickerDetailLabel, pickerItemKey } from "./model-list.js"

/**
 * The model catalog overlay, opened from the composer's model chip. The catalog loads on open and reloads when an
 * in-flight load settles (download flags move); progress and failures stream in through status events and are
 * overlaid onto the fetched rows. Selection resolves through the main process, which owns the model host.
 */
export function ModelPicker({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState()
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const modelLoad = state?.modelLoad ?? null
  const scrollbar = useScrollbarFlash()

  const load = useCallback(async () => {
    try {
      setItems(await api.listModels())
      setListError(undefined)
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // A finished load changes downloaded flags and availability labels; refresh the catalog once it settles.
  const loadWasInFlight = useRef(false)
  useEffect(() => {
    if (modelLoad) {
      loadWasInFlight.current = true
      return
    }
    if (!loadWasInFlight.current) return
    loadWasInFlight.current = false
    void load()
  }, [modelLoad, load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose])

  const select = async (item: ModelPickerChoice) => {
    if (!isPickerRowSelectable(item)) return
    setActionError(undefined)
    const result = await api.selectModel(pickerItemKey(item))
    if (result.ok) {
      onClose()
      return
    }
    // Cancelled or superseded selections are the user's own doing; the row simply returns to normal.
    if (result.reason !== "The selection was cancelled." && result.reason !== "The selection was superseded.") {
      setActionError(result.reason)
    }
  }

  const rows = mergeModelLoad(items ?? [], modelLoad)
  const selectionInFlight = modelLoad?.status.kind === "progress"

  return (
    <>
      <button type="button" className="overlayBackdrop" aria-label="Close model picker" onClick={onClose} />
      <div className="modelPicker noDrag" role="dialog" aria-modal="true" aria-label="Select a model">
        <div className="modelPicker-title">
          <span>Models</span>
          <IconButton icon={X} label="Close model picker" size={22} onClick={onClose} />
        </div>
        {listError ? <div className="modelPicker-message modelPicker-error">{listError}</div> : null}
        {actionError ? <div className="modelPicker-message modelPicker-error">{actionError}</div> : null}
        {!items && !listError ? <div className="modelPicker-message">Loading models…</div> : null}
        {/* The thumb appears on hover and flashes while scrolling, like the sidebar and transcript lists. */}
        <div className={`modelPicker-list${scrollbar.scrolling ? " scrolling" : ""}`} onScroll={scrollbar.onScroll}>
          {rows.map((item) =>
            item.kind === "header" ? (
              <div key={item.id} className="modelPicker-header">
                {item.displayName}
              </div>
            ) : (
              <ModelRow
                key={pickerItemKey(item)}
                item={item}
                selectionInFlight={selectionInFlight === true}
                onSelect={select}
                onCancel={() => void api.cancelModelSelection()}
              />
            ),
          )}
        </div>
      </div>
    </>
  )
}

function ModelRow({
  item,
  selectionInFlight,
  onSelect,
  onCancel,
}: {
  item: ModelPickerChoice
  selectionInFlight: boolean
  onSelect: (item: ModelPickerChoice) => void
  onCancel: () => void
}) {
  const selectable = isPickerRowSelectable(item)
  const status = "status" in item ? item.status : undefined
  const loading = status?.kind === "progress"
  return (
    <div className={`modelPicker-row${item.active ? " active" : ""}`}>
      <button
        type="button"
        className="modelPicker-select"
        disabled={!selectable || loading}
        onClick={() => void onSelect(item)}
      >
        <span className="modelPicker-rowText">
          <span className="modelPicker-name">
            {item.displayName}
            {"recommended" in item && item.recommended ? (
              <span className="modelPicker-recommended" title="Recommended for this machine">
                <Icon icon={Star} size={11} />
              </span>
            ) : null}
          </span>
          <span className={`modelPicker-detail${status?.kind === "error" ? " error" : ""}`}>
            {loading ? <span className="modelPicker-spinner">{<Icon icon={Loader2} size={11} />}</span> : null}
            {status?.label ?? pickerDetailLabel(item)}
          </span>
        </span>
        {item.active ? <Icon icon={Check} size={13} /> : null}
        {"downloaded" in item && !item.downloaded && selectable && !selectionInFlight ? (
          <span className="modelPicker-downloadHint" title="Downloads when selected">
            <Icon icon={Download} size={12} />
          </span>
        ) : null}
      </button>
      {loading ? (
        <IconButton icon={X} label="Cancel model load" size={22} className="modelPicker-cancel" onClick={onCancel} />
      ) : null}
    </div>
  )
}
