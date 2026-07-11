# Brand

The `brand` Harness Module owns brand Resources. Its `descriptor` Source accepts
host- or Package-resolved content through `HcpMagnet.build(context)` and exposes
that data through `toResource()`. `brand/HcpServer.ts` remains the real owner of
all resulting `brand:<name>` addresses; Package is input provenance, not an HCP
role.
