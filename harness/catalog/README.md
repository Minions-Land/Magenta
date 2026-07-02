# Harness Catalog

This module imports the Magenta 1 `general-harness` component inventory into
Magenta3 as selectable metadata.

It intentionally separates two concepts:

- `harness/harness.toml` `[[components]]`: Magenta3 components that are currently
  registered for assembly.
- `harness/harness.toml` `[[catalogs]]`: inventories of migrated or candidate
  harness components that a selector can show, filter, and later wire through a
  Magnet.

The Magenta 1 source data is preserved in
`magenta1-components-inventory.json`. The schema in
`component-catalog.schema.json` describes the required inventory shape. The
integration map marks entries already covered by Magenta3 native TS harness
modules, plus entries that are locally selectable through generic Magnet/runtime
adapters without being mounted into the default agent session.

Selector readiness uses both fields:

- `integrated`: default Magenta3 component coverage.
- `available` with `component`: locally runnable/selectable through a generic
  adapter, but not part of the default loop surface.
- `requires-migration`: Magenta1 capability is not yet exposed as an equivalent
  Magenta3 component/HCP target. Some entries note partial coverage by existing
  Magenta3 APIs, but they are not selector-ready.
- `metadata-only`: provenance/demo/reference entry that should not be mounted.
- `external-boundary`: tracked boundary to code or systems outside the harness
  execution catalog.
