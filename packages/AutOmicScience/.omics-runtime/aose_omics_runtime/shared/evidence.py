"""
Evidence record shaping for omics analysis.

Converts a helper/analysis report dict into the exact trailing-JSON row
that the Rust analyst harness harvests into an EvidenceRecord.

Functions:
- shape_row(): Canonicalize report dict into evidence JSON structure
- emit(): Returns JSON string for print() as cell's last line

Constants:
- EVIDENCE_KIND: "computation"
- SCHEMA_VERSION: 1
"""

import json
from datetime import datetime, timezone
from typing import Any


# Constants (single source of truth for evidence format)
EVIDENCE_KIND = "computation"
SCHEMA_VERSION = 1


def shape_row(
    report: dict[str, Any],
    *,
    analysis: str,
    identifier: str,
    summary: str | None = None,
) -> dict[str, Any]:
    """
    Shape a report dict into an evidence record structure.

    The Rust side harvests this JSON from the cell's trailing output
    and converts it into an EvidenceRecord::from_computation + TraceStep
    appended to runs/omics/<id>/evidence.jsonl.

    Parameters
    ----------
    report : dict
        The computation output (parameters, results, metrics)
    analysis : str
        Analysis type (e.g., "preprocess", "cluster", "rank_genes")
    identifier : str
        Unique identifier (e.g., run_id, step_name)
    summary : str, optional
        Human-readable summary (if not provided, derived from analysis)

    Returns
    -------
    dict
        Evidence record structure ready for JSON serialization

    Raises
    ------
    ValueError
        If report is not JSON-serializable, or analysis/identifier are empty
    """
    if not isinstance(report, dict):
        raise ValueError(f"report must be a dict, got {type(report)}")

    if not analysis or not analysis.strip():
        raise ValueError("analysis must be a non-empty string")

    if not identifier or not identifier.strip():
        raise ValueError("identifier must be a non-empty string")

    # Test JSON serializability
    try:
        json.dumps(report)
    except (TypeError, ValueError) as e:
        raise ValueError(f"report must be JSON-serializable: {e}")

    # Generate summary if not provided
    if summary is None:
        summary = f"{analysis} [{identifier}]"

    # Build evidence row
    row = {
        "schema": SCHEMA_VERSION,
        "kind": EVIDENCE_KIND,
        "analysis": analysis.strip(),
        "identifier": identifier.strip(),
        "summary": summary,
        "report": report,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    return row


def emit(
    report: dict[str, Any],
    *,
    analysis: str,
    identifier: str,
    summary: str | None = None,
) -> str:
    """
    Convert report dict to JSON string for printing as cell's last line.

    Usage in notebook cell:
    ```python
    # ... run computation ...
    report = {"n_clusters": 12, "resolution": 1.0, "n_obs": 5000}
    print(emit(report, analysis="cluster", identifier="leiden_r1.0"))
    ```

    The Rust analyst tool will parse this JSON and create an EvidenceRecord.

    Parameters
    ----------
    report : dict
        The computation output
    analysis : str
        Analysis type
    identifier : str
        Unique identifier
    summary : str, optional
        Human-readable summary

    Returns
    -------
    str
        JSON string ready to print()
    """
    row = shape_row(report, analysis=analysis, identifier=identifier, summary=summary)
    return json.dumps(row, ensure_ascii=False)


def emit_compact(
    report: dict[str, Any],
    *,
    analysis: str,
    identifier: str,
    summary: str | None = None,
) -> str:
    """
    Like emit(), but with compact JSON (no extra whitespace).

    Useful for large reports to reduce output size.
    """
    row = shape_row(report, analysis=analysis, identifier=identifier, summary=summary)
    return json.dumps(row, ensure_ascii=False, separators=(',', ':'))
