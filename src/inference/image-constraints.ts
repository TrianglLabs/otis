export const MAX_IMAGES_PER_REQUEST = 30
export const MAX_BASE64_IMAGE_BYTES = 10_000_000
export const MAX_RAW_IMAGE_BYTES = Math.floor(((MAX_BASE64_IMAGE_BYTES - 1) * 3) / 4)

export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".ppm"] as const

export function base64EncodedLength(byteLength: number) {
  return 4 * Math.ceil(byteLength / 3)
}
