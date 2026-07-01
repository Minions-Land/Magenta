/**
 * File-mutation queue now lives in the harness package (pure, no-render logic).
 * Re-exported from "@magenta/harness" so existing pi importers (tools barrel,
 * file-mutation-queue tests) keep their stable import paths.
 */
export { withFileMutationQueue } from "@magenta/harness";
