// Sound files are bundled by Metro as assets; a `require`/import yields the asset's module id.
declare module '*.wav' {
  const asset: number;
  export default asset;
}
