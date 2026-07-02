# AutOmicScience Brand

Package-local brand override for the AutOmicScience harness package.

The palette is migrated from BioAgent/AutOmicScience's Nature-inspired TUI theme:

- Primary: `#006633`
- Accent: `#008080`
- Link/API accent: `#0066CC`
- Warning: `#BF5700`
- Error: `#CC0000`

`brand.toml` is the package-local descriptor. `AutOmicScience.brand.ts` mirrors
the root `BrandConfig` shape so future brand activation can consume the package
resource without depending on the external BioAgent checkout.
