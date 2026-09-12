import { ArrowUp, ChevronDown, FolderOpen, ImagePlus, Square, X, Zap } from "lucide-react"
import { memo, useEffect, useRef, useState } from "react"
import {
  base64EncodedLength,
  MAX_BASE64_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
  MAX_RAW_IMAGE_BYTES,
  SUPPORTED_IMAGE_EXTENSIONS,
} from "../../../../inference/image-constraints.js"
import type { DesktopImageInput } from "../../../contracts.js"
import { Button } from "../../components/Button.js"
import { Icon } from "../../components/Icon.js"
import { PROVIDER_LABELS, shortModelId } from "../../format.js"
import { useDesktop, useDesktopState } from "../../runtime.js"
import { ModelPicker } from "../models/ModelPicker.js"
import { draftAfterSend } from "./draft.js"

type PendingImage = DesktopImageInput & { id: number; previewUrl: string }

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/bmp,image/tiff,.tif,.tiff,.ppm"
const SUPPORTED_EXTENSIONS = new Set<string>(SUPPORTED_IMAGE_EXTENSIONS)
const SUPPORTED_MIME_TYPES = new Set([
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
  const dot = file.name.lastIndexOf(".")
  return (
    SUPPORTED_MIME_TYPES.has(file.type.toLowerCase()) ||
    (dot !== -1 && SUPPORTED_EXTENSIONS.has(file.name.slice(dot).toLowerCase()))
  )
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
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [addingImages, setAddingImages] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const pendingImagesRef = useRef<PendingImage[]>([])
  const addingImagesRef = useRef(false)
  const nextImageId = useRef(1)
  const dragDepth = useRef(0)

  const busy = state?.busy ?? false
  const modelState = state?.modelState ?? "unconfigured"
  const needsWorkspace = state?.needsWorkspace ?? false
  const supportsImages = state?.model?.supportsImageInput === true
  const hasMessage = draft.trim().length > 0 || pendingImages.length > 0
  const canSend =
    modelState === "ready" &&
    hasMessage &&
    !sending &&
    !addingImages &&
    !installing &&
    !needsWorkspace &&
    (pendingImages.length === 0 || supportsImages)
  const canAttach =
    modelState === "ready" && supportsImages && !sending && !addingImages && !installing && !needsWorkspace

  const replacePendingImages = (images: PendingImage[]) => {
    pendingImagesRef.current = images
    setPendingImages(images)
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }, [draft])

  useEffect(
    () => () => {
      for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl)
    },
    [],
  )

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0 || addingImagesRef.current) return
    if (!supportsImages) {
      setSendError("The selected model does not support image input. Choose a vision model.")
      return
    }

    const current = pendingImagesRef.current
    if (current.length + files.length > MAX_IMAGES_PER_REQUEST) {
      setSendError(`You can attach at most ${MAX_IMAGES_PER_REQUEST} images to one message.`)
      return
    }
    const unsupported = files.find((file) => !supportedImageFile(file))
    if (unsupported) {
      setSendError(
        `${unsupported.name || "That file"} is not a supported image. Use PNG, JPEG, GIF, BMP, TIFF, or PPM.`,
      )
      return
    }
    const invalidSize = files.find((file) => file.size === 0 || file.size > MAX_RAW_IMAGE_BYTES)
    if (invalidSize) {
      setSendError(
        invalidSize.size === 0
          ? `${invalidSize.name} is empty.`
          : `${invalidSize.name} is too large. Image data must stay under the 10 MB request limit.`,
      )
      return
    }
    const encodedBytes =
      current.reduce((total, image) => total + base64EncodedLength(image.bytes.byteLength), 0) +
      files.reduce((total, file) => total + base64EncodedLength(file.size), 0)
    if (encodedBytes >= MAX_BASE64_IMAGE_BYTES) {
      setSendError("The attached images are too large together. Total image data must stay under 10 MB.")
      return
    }

    addingImagesRef.current = true
    setAddingImages(true)
    setSendError(null)
    try {
      const bytes = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())))
      const additions = files.map(
        (file, index): PendingImage => ({
          id: nextImageId.current++,
          name: file.name,
          mimeType: SUPPORTED_MIME_TYPES.has(file.type.toLowerCase()) ? file.type : "",
          bytes: bytes[index],
          previewUrl: URL.createObjectURL(file),
        }),
      )
      replacePendingImages([...current, ...additions])
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "The image could not be read.")
    } finally {
      addingImagesRef.current = false
      setAddingImages(false)
    }
  }

  const removeImage = (id: number) => {
    const image = pendingImagesRef.current.find((candidate) => candidate.id === id)
    if (image) URL.revokeObjectURL(image.previewUrl)
    replacePendingImages(pendingImagesRef.current.filter((candidate) => candidate.id !== id))
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
    const images = pendingImagesRef.current
    if (
      (!text.trim() && images.length === 0) ||
      sending ||
      addingImages ||
      modelState !== "ready" ||
      installing ||
      needsWorkspace
    ) {
      return
    }
    if (images.length > 0 && !supportsImages) {
      setSendError("The selected model does not support image input. Choose a vision model.")
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const result = await api.sendPrompt(
        text,
        images.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
      )
      if (result.accepted) {
        setDraft((current) => draftAfterSend(current, text, true))
        for (const image of images) URL.revokeObjectURL(image.previewUrl)
        replacePendingImages([])
      } else {
        setSendError(`${result.reason} Your message was kept.`)
      }
    } catch (error) {
      setSendError(`${error instanceof Error ? error.message : String(error)} Your message was kept.`)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const placeholder = installing
    ? "Restarting into the update…"
    : needsWorkspace
      ? "Locate the working folder to continue this session"
      : modelState === "starting"
        ? "Starting the model…"
        : modelState === "ready"
          ? busy
            ? "Steer the active turn, or queue a follow-up…"
            : "Ask Otis anything…"
          : "Set up a model to start chatting"

  return (
    <div className="composer">
      {modelState === "failed" && state?.modelError ? (
        <div className="composer-banner" role="alert">
          The model could not start: {state.modelError}
        </div>
      ) : null}
      <form
        aria-label="Message composer"
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
          void addImageFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {dragActive ? <div className="composer-dropOverlay">Drop images here</div> : null}
        {pendingImages.length > 0 ? (
          <ul className="composer-attachments" aria-label="Attached images">
            {pendingImages.map((image) => (
              <li className="composer-attachment" key={image.id} title={image.name}>
                <img src={image.previewUrl} alt="" />
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  disabled={sending}
                  onClick={() => removeImage(image.id)}
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
          aria-label="Prompt"
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
                  title={`${state.model.id} · ${PROVIDER_LABELS[state.model.provider] ?? state.model.provider}${state.fastServing.enabled ? " · Fast serving" : ""} — select a model`}
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
                title={workspaceError ?? `${state.workspace.path} — open a different folder`}
                onClick={() => void openFolder()}
              >
                <Icon icon={FolderOpen} size={11} />
                {workspaceFolderName(state.workspace)}
              </button>
            ) : null}
          </span>
          <span className="composer-actions">
            {busy ? (
              <Button variant="danger" size="sm" icon={Square} onClick={() => void api.stop()} title="Stop (Esc)">
                Stop
              </Button>
            ) : null}
            <input
              ref={imageInputRef}
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                void addImageFiles(Array.from(event.target.files ?? []))
                event.target.value = ""
              }}
            />
            <span
              className="composer-uploadWrap"
              title={supportsImages ? "Add images" : "The selected model does not support image input"}
            >
              <button
                type="button"
                className="composer-upload iconBtn"
                aria-label="Add images"
                disabled={!canAttach}
                onClick={() => imageInputRef.current?.click()}
              >
                <Icon icon={ImagePlus} size={14} />
              </button>
            </span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              iconAfter={ArrowUp}
              disabled={!canSend}
              title={busy ? "Send as follow-up (Enter)" : "Send (Enter)"}
            >
              {busy ? "Follow up" : "Send"}
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
