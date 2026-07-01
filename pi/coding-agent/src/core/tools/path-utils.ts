/**
 * Path helpers now live in the harness package (pure, no-render logic).
 * Re-exported from "@magenta/harness" so existing pi importers (read tool,
 * file-processor, path-utils tests) keep their stable import paths.
 */
export { expandPath, pathExists, resolveReadPath, resolveReadPathAsync, resolveToCwd } from "@magenta/harness";
