/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  /** XYZ template for the offline raster basemap, e.g. /tiles/{z}/{x}/{y}.png */
  readonly VITE_TILES_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
