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
modules, so duplicated process-tool or declared-tool records are not re-added as
separate implementations.
