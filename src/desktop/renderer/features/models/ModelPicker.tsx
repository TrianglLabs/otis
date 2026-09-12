import { Check, Download, Eye, Loader2, Star, Text, Trash2, X } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { useScrollbarFlash } from "../../useScrollbarFlash.js"
import { isPickerRowSelectable, mergeModelLoad, pickerDetailParts, pickerItemKey } from "./model-list.js"

/**
 * The model catalog overlay, opened from the composer's model chip. The catalog loads on open and reloads when an
 * in-flight load settles (download flags move); progress and failures stream in through status events and are
 * overlaid onto the fetched rows. Selection resolves through the main process, which owns the model host.
 * Downloaded managed-local models carry a delete affordance: hover the row, confirm, and the main process removes
 * the cached GGUFs — stopping the server and clearing the selection first when that model is the active one.
 */
export function ModelPicker({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const state = useDesktopState("modelLoad")
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string>()
  // The row being deleted, while the main process removes the GGUFs: the row shows progress and every
  // conflicting control (select, other deletes) stays disabled until it settles.
  const [deletingKey, setDeletingKey] = useState<string>()
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
      // A pending delete confirmation absorbs the first Escape; the next one closes the catalog.
      if (confirmingDeleteKey !== undefined) setConfirmingDeleteKey(undefined)
      else onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [onClose, confirmingDeleteKey])

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

  const deleteModel = async (item: ModelPickerChoice) => {
    setConfirmingDeleteKey(undefined)
    setActionError(undefined)
    setDeletingKey(pickerItemKey(item))
    try {
      const result = await api.deleteLocalModel(item.id)
      // Downloaded flags — and the active row, when the active model was deleted — change; refetch the catalog.
      if (result.ok) void load()
      else setActionError(result.reason)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingKey(undefined)
    }
  }

  const rows = mergeModelLoad(items ?? [], modelLoad)
  const selectionInFlight = modelLoad?.status.kind === "progress"

  return (
    <>
      <button type="button" className="overlayBackdrop" aria-label="Close model picker" onClick={onClose} />
      <div className="modelPicker noDrag" role="dialog" aria-modal="true" aria-label="Select a model">
        {/* Borderless title bar like the coworker trace's header: label left, close button at the edge. */}
        <div className="modelPicker-title">
          <span className="modelPicker-titleText">Select a model</span>
          <span className="modelPicker-titleSpace" />
          <IconButton icon={X} label="Close model picker" size={22} onClick={onClose} />
        </div>
        {listError ? <div className="modelPicker-message modelPicker-error">{listError}</div> : null}
        {actionError ? <div className="modelPicker-message modelPicker-error">{actionError}</div> : null}
        {!items && !listError ? <div className="modelPicker-message">Loading models…</div> : null}
        {/* The thumb appears on hover and flashes while scrolling, like the transcript. */}
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
                confirmingDelete={confirmingDeleteKey === pickerItemKey(item)}
                deleting={deletingKey === pickerItemKey(item)}
                deletionInFlight={deletingKey !== undefined}
                onSelect={select}
                onCancel={() => void api.cancelModelSelection()}
                onRequestDelete={() => {
                  setActionError(undefined)
                  setConfirmingDeleteKey(pickerItemKey(item))
                }}
                onDelete={() => void deleteModel(item)}
                onKeep={() => setConfirmingDeleteKey(undefined)}
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
  confirmingDelete,
  deleting,
  deletionInFlight,
  onSelect,
  onCancel,
  onRequestDelete,
  onDelete,
  onKeep,
}: {
  item: ModelPickerChoice
  selectionInFlight: boolean
  confirmingDelete: boolean
  deleting: boolean
  deletionInFlight: boolean
  onSelect: (item: ModelPickerChoice) => void
  onCancel: () => void
  onRequestDelete: () => void
  onDelete: () => void
  onKeep: () => void
}) {
  const selectable = isPickerRowSelectable(item)
  const status = "status" in item ? item.status : undefined
  const loading = status?.kind === "progress"
  // Only a downloaded managed-local model has files on this machine to remove.
  const deletable = item.provider === "local" && "downloaded" in item && item.downloaded && !loading
  return (
    <div className={`modelPicker-row${item.active ? " active" : ""}`}>
      {deleting ? (
        <div className="modelPicker-confirm">
          <span className="modelPicker-confirmText">Deleting {item.displayName}…</span>
          <span className="modelPicker-spinner">
            <Icon icon={Loader2} size={12} />
          </span>
        </div>
      ) : confirmingDelete ? (
        <div className="modelPicker-confirm">
          <span className="modelPicker-confirmText">Delete {item.displayName}?</span>
          <Button variant="ghost" size="sm" onClick={onKeep}>
            Keep
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="modelPicker-select"
            disabled={!selectable || loading || deletionInFlight}
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
                {status?.label ?? <ModelDetail item={item} />}
              </span>
            </span>
          </button>
          {/* Trailing marks share the icon buttons' box (see .modelPicker-mark) so the row's right rail —
              active check, cancel, delete, download hint — lines up across every row. */}
          {item.active ? (
            <span className="modelPicker-mark">
              <Icon icon={Check} size={13} />
            </span>
          ) : null}
          {loading ? (
            <IconButton
              icon={X}
              label="Cancel model load"
              size={22}
              className="modelPicker-cancel"
              onClick={onCancel}
            />
          ) : null}
          {deletable ? (
            <IconButton
              icon={Trash2}
              label={`Delete ${item.displayName}`}
              size={22}
              className="modelPicker-delete"
              disabled={deletionInFlight}
              onClick={onRequestDelete}
            />
          ) : null}
          {"downloaded" in item && !item.downloaded && selectable && !selectionInFlight ? (
            <span className="modelPicker-mark modelPicker-downloadHint" title="Downloads when selected">
              <Icon icon={Download} size={12} />
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}

function ModelDetail({ item }: { item: ModelPickerChoice }) {
  return pickerDetailParts(item).map((part, index) => (
    <Fragment key={`${part.label}-${index}`}>
      {index > 0 ? <span aria-hidden>·</span> : null}
      <span className={part.modality ? `modelPicker-modality modelPicker-modality-${part.modality}` : undefined}>
        {part.modality ? <Icon icon={part.modality === "vision" ? Eye : Text} size={11} /> : null}
        {part.label}
      </span>
    </Fragment>
  ))
}
