"""Spatial transcriptomics modules."""
from . import read_spatial

# Note: spatial statistics (SVG / neighborhood enrichment / co-occurrence /
# Ripley) is a skill method recipe (skills/omics/spatial/method/spatial_stats.md)
# invoking squidpy directly, NOT a runtime module — so it is intentionally not
# imported here. The previous `from . import spatial_stats` referenced a module
# that never existed and broke every spatial subcommand on import.

__all__ = ["read_spatial"]
