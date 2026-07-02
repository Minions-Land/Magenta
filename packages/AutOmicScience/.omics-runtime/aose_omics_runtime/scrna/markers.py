"""Marker gene analysis — re-export of the canonical `marker_table` module.

Historically this module re-implemented `marker_table()`, `is_noise_gene()`, the
noise-gene constants, and `format_marker_summary()` — a near-duplicate of
`marker_table.py` (CLAUDE.md Generalization Principle violation). The single
source of truth is now `marker_table.py`; this module re-exports it so existing
`from .scrna import markers` / `markers.marker_table(...)` callers keep working.
`marker_table()` returns `(DataFrame, report_dict | None)`.
"""
from .marker_table import *  # noqa: F401,F403
from .marker_table import (  # explicit for linters / star-safety
    marker_table,
    format_marker_summary,
    export_markers_for_enrichment,
    is_noise_gene,
    main,
)
