declare module "*.css"

declare module "*.svg" {
  const url: string
  export default url
}

declare module "*.mp3" {
  const url: string
  export default url
}
