// Images are bundled by Metro as assets; an import yields the asset's module id.
declare module '*.png' {
  const asset: number;
  export default asset;
}
