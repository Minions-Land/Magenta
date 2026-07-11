# Themes

The `themes` Harness Module owns theme Resources. Its `descriptor` Source accepts
host- or Package-resolved content through `HcpMagnet.build(context)` and exposes
that data through `toResource()`. `themes/HcpServer.ts` remains the real owner
of every resulting Resource address; Package is input provenance, not an HCP
role.
