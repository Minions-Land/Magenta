//! Local-compute bioinformatics algorithms (pure Rust, no Python, no external binaries).
//!
//! These modules replace the `gget` subcommands that perform **local computation**
//! rather than hitting an HTTP API:
//!
//! * [`mutate`] — apply HGVS-style mutations to sequences (`gget mutate`).
//! * [`muscle`] — center-star multiple sequence alignment (`gget muscle`).
//! * [`diamond`] — Smith-Waterman all-pairs local alignment search (`gget diamond`).
//!
//! All three build on the pure-Rust pairwise aligners in [`pairwise`]. They are
//! always compiled (no optional feature gate) so the corresponding tools work
//! without any extra build configuration.

pub mod diamond;
pub mod muscle;
pub mod mutate;
pub mod pairwise;
