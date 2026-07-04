# SSH Tool Backend

The **ssh** tool module provides SSH-backed operation adapters for Magenta/Pi
workspace tools. It is not exposed to the model as a separate `ssh` tool.

Instead, Pi's `--ssh user@host[:/path]` mode uses this module to run the existing
`read`, `write`, `edit`, and `bash` tools against a remote workspace.

## Requirements

- SSH key-based authentication; password prompts are not supported.
- `ssh`, `bash`, `cat`, `test`, `mkdir`, `base64`, and `file` available where
  the backend uses them.
- Remote paths are mapped from the local session cwd. Paths outside that mapped
  local root are rejected.
