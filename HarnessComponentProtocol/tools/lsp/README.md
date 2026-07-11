# LSP Tool

The `lsp` Tool provides diagnostics, symbols, definitions, references, hover,
rename, code actions, status, and related language-intelligence operations.

```text
HcpClient -> tools/lsp/HcpServer -> tools/lsp/magenta/HcpMagnet -> ProcessTool
```

`lsp.toml` declares the Module and selects the `magenta` Source. The Source reads
`magenta/lsp.toml`, resolves the shared process-tool binary, and requires the
selected `runtime:process` and `sandbox` Capabilities before producing a normal
Tool. Process is an implementation mechanism inside the Source, not another
Module or HCP role.

The component is available for explicit assembly and is not marked `autoload`
in its repository declaration.
