// Shared by intake validation and the browser; AI context has independent bounds.
export const PROJECT_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxProjectBytes: 128_000_000,
  maxFileBytes: 32_000_000,
  maxRequestBytes: 180_000_000,
});
export const formatBytes = (bytes) =>
  bytes < 1000
    ? `${bytes} B`
    : bytes < 1_000_000
      ? `${(bytes / 1000).toFixed(1)} KB`
      : `${(bytes / 1_000_000).toFixed(1)} MB`;
