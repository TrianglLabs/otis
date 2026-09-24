import { Cpu, Download, Eye, Loader2, Star, Text, Trash2, X } from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { ModelPickerItem } from "../../../../inference/picker-catalog.js"
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
        <div className="modelPicker-title">
          <h2 className="modelPicker-titleText">{t("models.select")}</h2>
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
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        setConfirmingDeleteKey(undefined)
                        setActionError(undefined)
                        setDeletingKey(key)
                        try {
                          const result = await api.deleteLocalModel(item.id)
                          if (result.ok) void load()
                          else setActionError(result.reason)
                        } catch (error) {
                          setActionError(error instanceof Error ? error.message : String(error))
                        } finally {
                          setDeletingKey(undefined)
                        }
                      }}
                    >
                      {t("palette.delete")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="modelPicker-select"
                      disabled={!selectable || loading || deletingKey !== undefined}
                      onClick={async () => {
                        setActionError(undefined)
                        const result = await api.selectModel(key)
                        if (result.ok) return onClose()
                        // Cancellation and supersession simply return the row to normal.
                        if (
                          result.reason !== "The selection was cancelled." &&
                          result.reason !== "The selection was superseded."
                        ) {
                          setActionError(result.reason)
                        }
                      }}
                    >
                      <span className="modelPicker-rowText">
                        <span className="modelPicker-name">
                          <span>{item.displayName}</span>
                          {"recommended" in item && item.recommended ? (
                            <span
                              className="modelPicker-recommended"
                              title={t("common.recommended")}
                            >
                              <Icon icon={Star} size={11} />
                            </span>
                          ) : null}
                          {"cpuOffload" in item && item.cpuOffload ? (
                            <span
                              className="modelPicker-cpuOffload"
                              title={t("models.partlyOnCpu")}
                            >
                              <Icon icon={Cpu} size={11} />
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
                    {/* The active row is the highlighted one; its rail holds only the trash,
                        shown on hover for a downloaded model. Cancel and the download hint have
                        their own slots only while they apply. */}
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
                    {loading ? (
                      <IconButton
                        icon={X}
                        label={t("common.cancelModelLoad")}
                        size={22}
                        className="modelPicker-cancel"
                        onClick={() => void api.cancelModelSelection()}
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
