import { Check, Download, Eye, Loader2, Star, Text, Trash2, X } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { ModelPickerChoice, ModelPickerItem } from "../../../../inference/picker-catalog.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState, useScrollbarFlash } from "../../runtime.js"
import {
  isPickerRowSelectable,
  mergeModelLoad,
  pickerDetailParts,
  pickerItemKey,
} from "./model-list.js"

/**
 * The model catalog overlay, opened from the composer's model chip. The catalog loads on open and
 * reloads when an in-flight load settles (download flags move); progress and failures stream in
 * through status events and are overlaid onto the fetched rows. Selection resolves through the main
 * process, which owns the model host. Downloaded managed-local models carry a delete affordance:
 * hover the row, confirm, and the main process removes the cached GGUFs — stopping the server and
 * clearing the selection first when that model is the active one.
 */
export function ModelPicker({ onClose }: { onClose: () => void }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState("modelLoad")
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string>()
  // The row being deleted, while the main process removes the GGUFs: the row shows progress and
  // every conflicting control (select, other deletes) stays disabled until it settles.
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

  // A finished load changes downloaded flags and availability labels; refresh the catalog once it
  // settles.
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
    setActionError(undefined)
    const result = await api.selectModel(pickerItemKey(item))
    if (result.ok) {
      onClose()
      return
    }
    // Cancelled or superseded selections are the user's own doing; the row simply returns to
    // normal.
    if (
      result.reason !== "The selection was cancelled." &&
      result.reason !== "The selection was superseded."
    ) {
      setActionError(result.reason)
    }
  }

  const deleteModel = async (item: ModelPickerChoice) => {
    setConfirmingDeleteKey(undefined)
    setActionError(undefined)
    setDeletingKey(pickerItemKey(item))
    try {
      const result = await api.deleteLocalModel(item.id)
      // Downloaded flags — and the active row, when the active model was deleted — change; refetch
      // the catalog.
      if (result.ok) void load()
      else setActionError(result.reason)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingKey(undefined)
    }
  }

  const rows = mergeModelLoad(items ?? [], modelLoad)

  return (
    <>
      <button
        type="button"
        className="overlayBackdrop"
        aria-label={t("models.close")}
        onClick={onClose}
      />
      <div
        className="modelPicker noDrag"
        role="dialog"
        aria-modal="true"
        aria-label={t("models.select")}
      >
        {/* Borderless title bar like the coworker trace's header: label left, close button at
            the edge. */}
        <div className="modelPicker-title">
          <span className="modelPicker-titleText">{t("models.select")}</span>
          <span className="modelPicker-titleSpace" />
          <IconButton icon={X} label={t("models.close")} size={22} onClick={onClose} />
        </div>
        {listError ? (
          <div className="modelPicker-message modelPicker-error">{listError}</div>
        ) : null}
        {actionError ? (
          <div className="modelPicker-message modelPicker-error">{actionError}</div>
        ) : null}
        {!items && !listError ? (
          <div className="modelPicker-message">{t("common.loadingModels")}</div>
        ) : null}
        {/* The thumb appears on hover and flashes while scrolling, like the transcript. */}
        <div
          className={`modelPicker-list${scrollbar.scrolling ? " scrolling" : ""}`}
          onScroll={scrollbar.onScroll}
        >
          {rows.map((item) => {
            if (item.kind === "header") {
              return (
                <div key={item.id} className="modelPicker-header">
                  {item.id === "header-pair"
                    ? t("models.serverHeading")
                    : item.id === "header-local"
                      ? t("models.local")
                      : item.id === "header-hosted"
                        ? t("models.hosted")
                        : item.displayName}
                </div>
              )
            }
            const key = pickerItemKey(item)
            const selectable = isPickerRowSelectable(item)
            const status = "status" in item ? item.status : undefined
            const loading = status?.kind === "progress"
            const detailClass = `modelPicker-detail${status?.kind === "error" ? " error" : ""}`
            // Only a downloaded managed-local model has files on this machine to remove.
            const deletable =
              item.provider === "local" &&
              "hasDownloadedPacking" in item &&
              item.hasDownloadedPacking &&
              !loading
            return (
              <div key={key} className={`modelPicker-row${item.active ? " active" : ""}`}>
                {deletingKey === key ? (
                  <div className="modelPicker-confirm">
                    <span className="modelPicker-confirmText">
                      {t("models.deletingName", { name: item.displayName })}
                    </span>
                    <span className="modelPicker-spinner">
                      <Icon icon={Loader2} size={12} />
                    </span>
                  </div>
                ) : confirmingDeleteKey === key ? (
                  <div className="modelPicker-confirm">
                    <span className="modelPicker-confirmText">
                      {t("models.deleteNameConfirm", { name: item.displayName })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingDeleteKey(undefined)}
                    >
                      {t("palette.keep")}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void deleteModel(item)}>
                      {t("palette.delete")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="modelPicker-select"
                      disabled={!selectable || loading || deletingKey !== undefined}
                      onClick={() => void select(item)}
                    >
                      <span className="modelPicker-rowText">
                        <span className="modelPicker-name">
                          {item.displayName}
                          {"recommended" in item && item.recommended ? (
                            <span
                              className="modelPicker-recommended"
                              title={t("common.recommended")}
                            >
                              <Icon icon={Star} size={11} />
                            </span>
                          ) : null}
                        </span>
                        <span className={detailClass}>
                          {loading ? (
                            <span className="modelPicker-spinner">
                              {<Icon icon={Loader2} size={11} />}
                            </span>
                          ) : null}
                          {status?.label ??
                            pickerDetailParts(item, t).map((part, index) => (
                              <Fragment key={`${part.label}-${index}`}>
                                {index > 0 ? <span aria-hidden>·</span> : null}
                                <span
                                  className={
                                    part.modality
                                      ? `modelPicker-modality modelPicker-modality-${part.modality}`
                                      : undefined
                                  }
                                >
                                  {part.modality ? (
                                    <Icon
                                      icon={part.modality === "vision" ? Eye : Text}
                                      size={11}
                                    />
                                  ) : null}
                                  {part.label}
                                </span>
                              </Fragment>
                            ))}
                        </span>
                      </span>
                    </button>
                    {/* Trailing marks share the icon buttons' box (see .modelPicker-mark) so the
                        row's right rail — active check, cancel, delete, download hint — lines up
                        across every row. */}
                    {item.active ? (
                      <span className="modelPicker-mark">
                        <Icon icon={Check} size={13} />
                      </span>
                    ) : null}
                    {loading ? (
                      <IconButton
                        icon={X}
                        label={t("common.cancelModelLoad")}
                        size={22}
                        className="modelPicker-cancel"
                        onClick={() => void api.cancelModelSelection()}
                      />
                    ) : null}
                    {deletable ? (
                      <IconButton
                        icon={Trash2}
                        label={t("models.deleteName", { name: item.displayName })}
                        size={22}
                        className="modelPicker-delete"
                        disabled={deletingKey !== undefined}
                        onClick={() => {
                          setActionError(undefined)
                          setConfirmingDeleteKey(key)
                        }}
                      />
                    ) : null}
                    {"downloaded" in item &&
                    !item.downloaded &&
                    selectable &&
                    modelLoad?.status.kind !== "progress" ? (
                      <span
                        className="modelPicker-mark modelPicker-downloadHint"
                        title={t("models.downloadingWhenSelected")}
                      >
                        <Icon icon={Download} size={12} />
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
