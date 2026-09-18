import { ArrowUp, ChevronDown, FileText, FolderOpen, Paperclip, Square, X, Zap } from "lucide-react"
import { memo, useEffect, useRef, useState } from "react"
import {
  MAX_DOCUMENTS_PER_MESSAGE,
  MAX_RAW_DOCUMENT_BYTES,
  MAX_TOTAL_DOCUMENT_BYTES,
  normalizedDocumentMimeType,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "../../../../inference/document-constraints.js"
import {
  base64EncodedLength,
  MAX_BASE64_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  MAX_RAW_IMAGE_BYTES,
  SUPPORTED_IMAGE_EXTENSIONS,
} from "../../../../inference/image-constraints.js"
import type { DesktopAttachmentInput } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { shortModelId } from "../../format.js"
import { useI18n } from "../../i18n/index.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { ModelPicker } from "../models/ModelPicker.js"
import { draftAfterSend } from "./draft.js"

type PendingAttachment = DesktopAttachmentInput & {
  id: number
  kind: "image" | "document"
  previewUrl?: string
}

const FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  ...(SUPPORTED_IMAGE_EXTENSIONS as readonly string[]),
  "text/*",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ...(SUPPORTED_DOCUMENT_EXTENSIONS as readonly string[]),
].join(",")
const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(SUPPORTED_IMAGE_EXTENSIONS)
const SUPPORTED_DOCUMENT_EXTENSION_SET = new Set<string>(SUPPORTED_DOCUMENT_EXTENSIONS)
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/x-png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/x-portable-pixmap",
])

function supportedImageFile(file: File) {
  const extension = fileExtension(file.name)
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase()) || SUPPORTED_IMAGE_EXTENSION_SET.has(extension)
}

function supportedDocumentFile(file: File) {
  return (
    Boolean(normalizedDocumentMimeType(file.type)) || SUPPORTED_DOCUMENT_EXTENSION_SET.has(fileExtension(file.name))
  )
}

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot).toLowerCase()
}

/**
 * The prompt composer. Enter sends, Shift+Enter inserts a newline, Escape stops active work. The draft is only
 * cleared after the application accepts the prompt (recorded in the session); on rejection the text stays put and
 * the reason is shown.
 */
/** The chip shows just the folder name; the full path stays in the tooltip. */
function workspaceFolderName(workspace: { label: string; path: string }): string {
  const parts = workspace.path.split("/").filter(Boolean)
  return parts.at(-1) ?? workspace.label
}

export const Composer = memo(function Composer({ installing = false }: { installing?: boolean }) {
  const { api } = useDesktop()
  const { t } = useI18n()
  const state = useDesktopState(
    "busy",
    "modelState",
    "needsWorkspace",
    "modelError",
    "model",
    "fastServing",
    "workspace",
  )
  const [draft, setDraft] = useState("")
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [addingAttachments, setAddingAttachments] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  const addingAttachmentsRef = useRef(false)
  const nextAttachmentId = useRef(1)
  const dragDepth = useRef(0)

  const busy = state?.busy ?? false
  const modelState = state?.modelState ?? "unconfigured"
  const needsWorkspace = state?.needsWorkspace ?? false
  const supportsImages = state?.model?.supportsImageInput === true
  const hasPendingImage = pendingAttachments.some((attachment) => attachment.kind === "image")
  const hasMessage = draft.trim().length > 0 || pendingAttachments.length > 0
  const canSend =
    modelState === "ready" &&
    hasMessage &&
    !sending &&
    !addingAttachments &&
    !installing &&
    !needsWorkspace &&
    (!hasPendingImage || supportsImages)
  const canAttach = modelState === "ready" && !sending && !addingAttachments && !installing && !needsWorkspace

  const replacePendingAttachments = (attachments: PendingAttachment[]) => {
    pendingAttachmentsRef.current = attachments
    setPendingAttachments(attachments)
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }, [draft])

  useEffect(
    () => () => {
      for (const attachment of pendingAttachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      }
    },
    [],
  )

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || addingAttachmentsRef.current) return

    const legacyWord = files.find(
      (file) => fileExtension(file.name) === ".doc" || file.type.toLowerCase() === "application/msword",
    )
    if (legacyWord) {
      setSendError(`Legacy Word .doc files are not supported. Save ${legacyWord.name} as .docx first.`)
      return
    }
    const classified = files.map((file) => ({
      file,
      kind: supportedImageFile(file)
        ? ("image" as const)
        : supportedDocumentFile(file)
          ? ("document" as const)
          : undefined,
    }))
    const unsupported = classified.find(({ kind }) => !kind)?.file
    if (unsupported) {
      setSendError(t("composer.unsupportedFile", { name: unsupported.name || t("composer.thatFile") }))
      return
    }
    if (classified.some(({ kind }) => kind === "image") && !supportsImages) {
      setSendError(t("composer.modelNoImageInput"))
      return
    }

    const current = pendingAttachmentsRef.current
    const currentImages = current.filter(({ kind }) => kind === "image")
    const currentDocuments = current.filter(({ kind }) => kind === "document")
    const newImages = classified.filter(({ kind }) => kind === "image")
    const newDocuments = classified.filter(({ kind }) => kind === "document")
    if (currentImages.length + newImages.length > MAX_IMAGES_PER_REQUEST) {
      setSendError(t("composer.atMostImages", { count: MAX_IMAGES_PER_REQUEST }))
      return
    }
    if (currentDocuments.length + newDocuments.length > MAX_DOCUMENTS_PER_MESSAGE) {
      setSendError(`You can attach at most ${MAX_DOCUMENTS_PER_MESSAGE} documents to one message.`)
      return
    }
    const invalidSize = classified.find(
      ({ file, kind }) =>
        file.size === 0 || (kind === "image" ? file.size > MAX_RAW_IMAGE_BYTES : file.size > MAX_RAW_DOCUMENT_BYTES),
    )
    if (invalidSize) {
      setSendError(
        invalidSize.file.size === 0
          ? t("composer.fileEmpty", { name: invalidSize.file.name })
          : invalidSize.kind === "image"
            ? t("composer.imageRequestLimit", { name: invalidSize.file.name })
            : `${invalidSize.file.name} is too large. Documents must be 20 MB or smaller.`,
      )
      return
    }
    const encodedBytes =
      currentImages.reduce((total, image) => total + base64EncodedLength(image.bytes.byteLength), 0) +
      newImages.reduce((total, { file }) => total + base64EncodedLength(file.size), 0)
    if (encodedBytes >= MAX_BASE64_IMAGE_BYTES) {
      setSendError(t("composer.imagesRequestLimit"))
      return
    }
    const documentBytes =
      currentDocuments.reduce((total, document) => total + document.bytes.byteLength, 0) +
      newDocuments.reduce((total, { file }) => total + file.size, 0)
    if (documentBytes > MAX_TOTAL_DOCUMENT_BYTES) {
      setSendError("Attached documents must total at most 30 MB.")
      return
    }

    addingAttachmentsRef.current = true
    setAddingAttachments(true)
    setSendError(null)
    try {
      const bytes = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())))
      const additions = classified.map(
        ({ file, kind }, index): PendingAttachment => ({
          id: nextAttachmentId.current++,
          kind: kind as "image" | "document",
          name: file.name,
          mimeType:
            kind === "image"
              ? SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())
                ? file.type
                : ""
              : (normalizedDocumentMimeType(file.type) ?? ""),
          bytes: bytes[index],
          ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
        }),
      )
      replacePendingAttachments([...current, ...additions])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : t("composer.fileReadFailed"))
    } finally {
      addingAttachmentsRef.current = false
      setAddingAttachments(false)
    }
  }

  const removeAttachment = (id: number) => {
    const attachment = pendingAttachmentsRef.current.find((candidate) => candidate.id === id)
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    replacePendingAttachments(pendingAttachmentsRef.current.filter((candidate) => candidate.id !== id))
    setSendError(null)
  }

  const openFolder = async () => {
    const path = await api.pickWorkspaceFolder()
    if (!path) return
    setWorkspaceError(undefined)
    const result = await api.openWorkspace(path)
    if (!result.ok) setWorkspaceError(result.reason)
  }

  const submit = async () => {
    const text = draft
    const attachments = pendingAttachmentsRef.current
    if (
      (!text.trim() && attachments.length === 0) ||
      sending ||
      addingAttachments ||
      modelState !== "ready" ||
      installing ||
      needsWorkspace
    ) {
      return
    }
    if (attachments.some(({ kind }) => kind === "image") && !supportsImages) {
      setSendError(t("composer.modelNoImageInput"))
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const result = await api.sendPrompt(
        text,
        attachments.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
      )
      if (result.accepted) {
        setDraft((current) => draftAfterSend(current, text, true))
        for (const attachment of attachments) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
        }
        replacePendingAttachments([])
      } else {
        setSendError(`${result.reason} ${t("composer.messageKept")}`)
      }
    } catch (error) {
      setSendError(`${error instanceof Error ? error.message : String(error)} ${t("composer.messageKept")}`)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const placeholder = installing
    ? t("composer.restarting")
    : needsWorkspace
      ? t("composer.locateFolder")
      : modelState === "starting"
        ? t("composer.startingModel")
        : modelState === "ready"
          ? busy
            ? t("composer.steer")
            : t("composer.ask")
          : t("composer.setupModel")

  return (
    <div className="composer">
      {modelState === "failed" && state?.modelError ? (
        <div className="composer-banner" role="alert">
          {t("composer.modelFailed", { error: state.modelError })}
        </div>
      ) : null}
      <form
        aria-label={t("composer.label")}
        className={`composer-box${busy ? " composer-boxWorking" : ""}${modelState !== "ready" && !busy ? " composer-boxDisabled" : ""}${dragActive ? " composer-boxDrop" : ""}`}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          dragDepth.current += 1
          setDragActive(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragActive(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragActive(false)
          void addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {dragActive ? <div className="composer-dropOverlay">{t("composer.dropFiles")}</div> : null}
        {pendingAttachments.length > 0 ? (
          <ul className="composer-attachments" aria-label={t("composer.attachedFiles")}>
            {pendingAttachments.map((attachment) => (
              <li
                className={`composer-attachment${attachment.kind === "document" ? " composer-attachmentDocument" : ""}`}
                key={attachment.id}
                title={attachment.name}
              >
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <span className="composer-documentPreview">
                    <Icon icon={FileText} size={22} />
                    <span>{fileExtension(attachment.name).slice(1).toUpperCase() || "TEXT"}</span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label={t("composer.removeAttachment", { name: attachment.name })}
                  disabled={sending}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <Icon icon={X} size={11} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          placeholder={placeholder}
          disabled={modelState !== "ready"}
          aria-label={t("composer.prompt")}
          onChange={(event) => {
            setDraft(event.target.value)
            setSendError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            } else if (event.key === "Escape" && busy) {
              event.preventDefault()
              void api.stop()
            }
          }}
        />
        <div className="composer-footer">
          <span className="composer-context">
            {state?.model ? (
              <>
                <button
                  type="button"
                  className={`composer-model${state.modelState === "starting" || state.modelState === "failed" ? ` composer-model-${state.modelState}` : ""}`}
                  onClick={() => setPickerOpen((open) => !open)}
                  title={t("composer.modelTitle", {
                    id: state.model.id,
                    provider:
                      state.model.provider === "fireworks"
                        ? "Fireworks"
                        : t(state.model.provider === "local" ? "models.local" : "models.localServers"),
                    fast: state.fastServing.enabled ? ` · ${t("composer.fastServing")}` : "",
                  })}
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                >
                  {state.fastServing.enabled ? <Icon icon={Zap} size={11} className="composer-fast" /> : null}
                  {state.model.displayName ?? shortModelId(state.model.id)}
                  <Icon icon={ChevronDown} size={11} />
                </button>
                {pickerOpen ? <ModelPicker onClose={() => setPickerOpen(false)} /> : null}
              </>
            ) : null}
            {state ? (
              <button
                type="button"
                className="composer-workspace noDrag"
                title={workspaceError ?? `${state.workspace.path} — ${t("composer.openDifferentFolder")}`}
                onClick={() => void openFolder()}
              >
                <Icon icon={FolderOpen} size={11} />
                {workspaceFolderName(state.workspace)}
              </button>
            ) : null}
          </span>
          <span className="composer-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []))
                event.target.value = ""
              }}
            />
            <span className="composer-uploadWrap" title={t("composer.addFiles")}>
              <button
                type="button"
                className="composer-upload iconBtn"
                aria-label={t("composer.addFiles")}
                disabled={!canAttach}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon icon={Paperclip} size={14} />
              </button>
            </span>
            {busy ? (
              <Button
                variant="danger"
                size="sm"
                icon={Square}
                onClick={() => void api.stop()}
                title={t("composer.stopTitle")}
              >
                {t("composer.stop")}
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              iconAfter={ArrowUp}
              disabled={!canSend}
              title={busy ? t("composer.sendFollowUpTitle") : t("composer.sendTitle")}
            >
              {busy ? t("composer.followUp") : t("composer.send")}
            </Button>
          </span>
        </div>
      </form>
      {sendError ? (
        <div className="composer-hint">
          <span className="composer-error">{sendError}</span>
        </div>
      ) : null}
    </div>
  )
})
