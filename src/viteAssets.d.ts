// Vite's `?url` imports: the file is emitted with the build and the import is its URL.
declare module '*?url' {
  const url: string
  export default url
}
