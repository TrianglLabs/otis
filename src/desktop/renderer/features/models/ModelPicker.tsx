import {
  ChevronLeft,
  CircleMinus,
  CirclePlus,
  CornerDownLeft,
  Cpu,
  Download,
  Eye,
  Info,
  Loader2,
  Search,
  Star,
  Text,
  Trash2,
  X,
} from "lucide-react"
import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import { localThinkingCapability } from "../../../../inference/local-thinking.js"
import { type LocalModelCard, localModelCard } from "../../../../inference/model-cards.js"
import type {
  LocalPickerChoice,
  ModelPickerChoice,
  ModelPickerItem,
} from "../../../../inference/picker-catalog.js"
import { filterModelPickerItems } from "../../../../inference/picker-filter.js"
import { Button, IconButton } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { formatContextWindow, formatMemory } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState, useScrollbarFlash } from "../../runtime.js"
import {
  isPickerRowSelectable,
  localModelFacts,
  mergeModelLoad,
  pickerDetailParts,
  pickerItemKey,
} from "./model-list.js"

/**
 * The model catalog overlay, opened from the composer's model chip. The catalog loads on open and
 * reloads when an in-flight load settles (download flags move); progress and failures stream in
 * through status events and are overlaid onto the fetched rows. A search box at the top narrows
 * the rows by name, id, or provider. Selection resolves through the main process, which
 * owns the model host. Downloaded managed-local models carry a delete affordance: hover the row,
 * confirm, and the main process removes the cached GGUFs — stopping the server and clearing the
 * selection first when that model is the active one. A managed-local row carries an info
 * affordance that pushes the model's card over the list: what it is, where it is strongest and
 * weakest by its author's account, its figures on this machine, and a button to select it.
 */
export function ModelPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState("modelLoad")
  const [items, setItems] = useState<ModelPickerItem[]>()
  const [query, setQuery] = useState("")
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string>()
  // The row being deleted, while the main process removes the GGUFs: the row shows progress and
  // every conflicting control (select, other deletes) stays disabled until it settles.
  const [deletingKey, setDeletingKey] = useState<string>()
  // The managed-local model whose card is pushed over the list.
  const [detailKey, setDetailKey] = useState<string>()
  const modelLoad = state?.modelLoad ?? null
  const scrollbar = useScrollbarFlash()
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setItems(await api.listModels())
      setListError(undefined)
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [api])

  // Hidden, not unmounted, while closed (see AppShell); the rows stay too, since hovered ones
  // carry transitions. Each open reloads the catalog behind a cleared search.
  useEffect(() => {
    if (open) {
      void load()
      inputRef.current?.focus()
      return
    }
    setQuery("")
    setActionError(undefined)
    setConfirmingDeleteKey(undefined)
    setDetailKey(undefined)
  }, [open, load])

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
    if (open) void load()
  }, [modelLoad, load, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      // A pushed card absorbs the first Escape, then a pending delete confirmation, then a search
      // query; the next one closes the catalog.
      if (detailKey !== undefined) setDetailKey(undefined)
      else if (confirmingDeleteKey !== undefined) setConfirmingDeleteKey(undefined)
      else if (query) setQuery("")
      else onClose()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open, onClose, detailKey, confirmingDeleteKey, query])

  const rows = filterModelPickerItems(mergeModelLoad(items ?? [], modelLoad), query)
  const noMatches =
    items !== undefined && query.trim() !== "" && !rows.some((r) => r.kind === "model")
  const detail = rows.find(
    (row): row is LocalPickerChoice =>
      row.kind === "model" && row.provider === "local" && pickerItemKey(row) === detailKey,
  )
  const detailCard = detail && localModelCard(detail.id)
  const select = async (key: string) => {
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
  }

  return (
    <>
      <button
        type="button"
        className="overlayBackdrop"
        aria-label={t("models.close")}
        onClick={onClose}
        hidden={!open}
      />
      <div
        className="popover modelPicker noDrag"
        role="dialog"
        aria-modal="true"
        aria-label={t("models.select")}
        hidden={!open}
      >
        {detail && detailCard ? (
          <ModelCard
            item={detail}
            card={detailCard}
            error={actionError}
            busy={modelLoad?.status.kind === "progress"}
            onBack={() => setDetailKey(undefined)}
            onSelect={() => void select(pickerItemKey(detail))}
          />
        ) : null}
        <div className="modelPicker-catalog" hidden={detail !== undefined}>
          <div className="popover-search">
            <Icon icon={Search} size={14} />
            <input
              ref={inputRef}
              type="text"
              placeholder={t("models.searchPlaceholder")}
              aria-label={t("models.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {noMatches ? <div className="modelPicker-message">{t("models.noMatches")}</div> : null}
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
                  <div key={item.id} className="popover-section">
                    {/* Hosted sections carry the provider's brand name, which is not translated. */}
                    {item.id === "header-pair"
                      ? t("models.serverHeading")
                      : item.id === "header-local"
                        ? t("models.local")
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
                        onClick={() => void select(key)}
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
                            {status?.label ?? <ModelDetail item={item} />}
                          </span>
                        </span>
                      </button>
                      {/* The active row is the highlighted one; its rail holds the info and trash
                        affordances, shown on hover. Cancel and the download hint have their own
                        slots only while they apply. */}
                      {item.provider === "local" && localModelCard(item.id) ? (
                        <IconButton
                          icon={Info}
                          label={t("models.cardAbout", { name: item.displayName })}
                          size={22}
                          className="modelPicker-info"
                          onClick={() => setDetailKey(key)}
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
          <div className="popover-footer">
            <Icon icon={CornerDownLeft} size={11} /> {t("popover.footer")}
          </div>
        </div>
      </div>
    </>
  )
}

/** A row's detail line — context, modality with its icon, Fast mode — shared with Settings. */
export function ModelDetail({ item }: { item: ModelPickerChoice }) {
  const { t } = useI18n()
  return pickerDetailParts(item, t).map((part, index) => (
    <Fragment key={`${part.label}-${index}`}>
      {index > 0 ? <span aria-hidden>·</span> : null}
      <span
        className={
          part.modality ? `modelPicker-modality modelPicker-modality-${part.modality}` : undefined
        }
      >
        {part.modality ? <Icon icon={part.modality === "vision" ? Eye : Text} size={11} /> : null}
        {part.label}
      </span>
    </Fragment>
  ))
}

/**
 * A managed-local model's card, pushed over the catalog list. The curated copy comes from the
 * author's model card; the figures strip comes from the picker's fit for this machine; the button
 * beside the name selects the model, downloading it first when it is not cached.
 */
function ModelCard({
  item,
  card,
  error,
  busy,
  onBack,
  onSelect,
}: {
  item: LocalPickerChoice
  card: LocalModelCard
  error?: string
  busy: boolean
  onBack: () => void
  onSelect: () => void
}) {
  const { t, locale } = useI18n()
  const thinking = localThinkingCapability(item.id)
  const facts = localModelFacts(item, t, locale)
  const fact = (term: string) => facts.find((entry) => entry.term === term)
  const quality = fact(t("models.factQualityTerm"))
  const bits = Number(item.quant?.match(/\d+/)?.[0])
  const last = thinking?.levels[thinking.levels.length - 1]
  // An estimate until the model loads, marked as the row marks it with "Est.".
  const context = formatContextWindow(item.contextLength).replace(/^~/, "")
  const stats: { term: string; value: string; hint?: string; cpu?: boolean }[] = [
    {
      term: t("models.factContextTerm"),
      value: item.loadedContextLength === undefined ? `~${context}` : context,
      hint: fact(t("models.factContextTerm"))?.hint,
    },
    ...(item.memoryBytes !== undefined
      ? [
          {
            term: t("models.factMemoryTerm"),
            value: formatMemory(item.memoryBytes),
            hint: item.cpuOffload ? t("models.partlyOnCpu") : undefined,
            cpu: item.cpuOffload,
          },
        ]
      : []),
    ...(quality
      ? [
          {
            term: quality.term,
            value: bits >= 16 ? quality.value : t("models.cardBits", { bits }),
            hint: `${quality.value} · ${quality.hint}`,
          },
        ]
      : []),
    {
      term: t("models.factInputTerm"),
      value: t(item.supportsImageInput ? "models.vision" : "models.text"),
    },
    {
      term: t("thinking.label"),
      value:
        thinking && last
          ? `${t(`thinking.${thinking.levels[0]}`)} – ${t(`thinking.${last}`)}`
          : t("models.cardThinkingNone"),
      hint: thinking
        ? t("models.cardThinking", {
            levels: thinking.levels.map((level) => t(`thinking.${level}`)).join(", "),
            level: t(`thinking.${thinking.defaultLevel}`),
          })
        : undefined,
    },
  ]
  return (
    <article className="modelCard" aria-label={item.displayName}>
      <div className="modelCard-bar">
        <button type="button" className="modelCard-back" onClick={onBack}>
          <Icon icon={ChevronLeft} size={16} />
          {t("models.cardBack")}
        </button>
      </div>
      <div className="modelCard-scroll">
        <header className="modelCard-hero">
          <div className="modelCard-headline">
            <div className="modelCard-naming">
              <h2 className="modelCard-title">
                {item.displayName}
                {item.recommended ? (
                  <span className="modelPicker-recommended" title={t("common.recommended")}>
                    <Icon icon={Star} size={14} />
                  </span>
                ) : null}
              </h2>
              <div className="modelCard-author">{card.author}</div>
            </div>
            {!item.available || item.active ? (
              <span className="modelCard-state">
                {item.active ? t("models.cardActive") : item.availabilityLabel}
              </span>
            ) : (
              <Button variant="primary" size="sm" disabled={busy} onClick={onSelect}>
                {item.downloaded ? null : <Icon icon={Download} size={12} />}
                {t(item.downloaded ? "models.cardUse" : "models.cardDownloadUse")}
              </Button>
            )}
          </div>
          {error ? <p className="modelCard-error">{error}</p> : null}
          <p className="modelCard-summary">{card.summary}</p>
        </header>
        <dl className="modelCard-stats">
          {stats.map((stat) => (
            <div key={stat.term} className="modelCard-stat" title={stat.hint}>
              <dt>{stat.term}</dt>
              <dd>
                {stat.value}
                {stat.cpu ? (
                  <span className="modelPicker-cpuOffload">
                    <Icon icon={Cpu} size={11} />
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
        {(
          [
            ["best", t("models.cardBestAt"), card.bestAt, CirclePlus],
            ["worst", t("models.cardWorstAt"), card.worstAt, CircleMinus],
          ] as const
        ).map(([tone, heading, claims, glyph]) => (
          <section key={tone} className="modelCard-section">
            <h3 className="modelCard-heading">{heading}</h3>
            <ul className="modelCard-group">
              {claims.map((claim) => (
                <li key={claim}>
                  <span className={`modelCard-glyph ${tone}`}>
                    <Icon icon={glyph} size={15} />
                  </span>
                  {claim}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="modelCard-source">
          {t("models.cardSourceNote")}{" "}
          <a href={card.source} target="_blank" rel="noreferrer">
            {t("models.cardSource")}
          </a>
        </p>
      </div>
    </article>
  )
}
