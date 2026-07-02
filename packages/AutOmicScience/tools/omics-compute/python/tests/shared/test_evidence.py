"""
Tests for evidence.py evidence record shaping.

Validates that shape_row and emit work correctly and produce
JSON that the Rust side can harvest into EvidenceRecord.
"""

import pytest
import json
from pathlib import Path
import sys
from datetime import datetime


from aose_omics_runtime.shared import evidence


def test_shape_row_basic():
    """shape_row should return valid evidence structure."""
    report = {"n_clusters": 12, "resolution": 1.0}

    row = evidence.shape_row(
        report,
        analysis="cluster",
        identifier="leiden_r1.0"
    )

    assert row["schema"] == evidence.SCHEMA_VERSION
    assert row["kind"] == evidence.EVIDENCE_KIND
    assert row["analysis"] == "cluster"
    assert row["identifier"] == "leiden_r1.0"
    assert row["report"] == report
    assert "timestamp" in row
    assert "summary" in row


def test_shape_row_custom_summary():
    """shape_row should use provided summary."""
    report = {"n_hvg": 2000}

    row = evidence.shape_row(
        report,
        analysis="preprocess",
        identifier="hvg_selection",
        summary="Selected 2000 highly variable genes"
    )

    assert row["summary"] == "Selected 2000 highly variable genes"


def test_shape_row_auto_summary():
    """shape_row should generate summary if not provided."""
    report = {"n_obs": 5000}

    row = evidence.shape_row(
        report,
        analysis="qc",
        identifier="filter_cells"
    )

    assert "qc" in row["summary"]
    assert "filter_cells" in row["summary"]


def test_shape_row_timestamp_format():
    """shape_row should include ISO8601 timestamp."""
    report = {"key": "value"}

    row = evidence.shape_row(
        report,
        analysis="test",
        identifier="test_id"
    )

    # Verify timestamp is valid ISO8601
    timestamp = row["timestamp"]
    parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
    assert isinstance(parsed, datetime)


def test_shape_row_non_dict_report_raises():
    """shape_row should raise ValueError for non-dict report."""
    with pytest.raises(ValueError) as exc_info:
        evidence.shape_row(
            "not a dict",
            analysis="test",
            identifier="test_id"
        )

    assert "must be a dict" in str(exc_info.value)


def test_shape_row_empty_analysis_raises():
    """shape_row should raise ValueError for empty analysis."""
    report = {"key": "value"}

    with pytest.raises(ValueError) as exc_info:
        evidence.shape_row(report, analysis="", identifier="test_id")

    assert "non-empty" in str(exc_info.value)


def test_shape_row_empty_identifier_raises():
    """shape_row should raise ValueError for empty identifier."""
    report = {"key": "value"}

    with pytest.raises(ValueError) as exc_info:
        evidence.shape_row(report, analysis="test", identifier="")

    assert "non-empty" in str(exc_info.value)


def test_shape_row_non_serializable_report_raises():
    """shape_row should raise ValueError for non-JSON-serializable report."""
    # Use a lambda which is not JSON-serializable
    report = {"func": lambda x: x}

    with pytest.raises(ValueError) as exc_info:
        evidence.shape_row(
            report,
            analysis="test",
            identifier="test_id"
        )

    assert "JSON-serializable" in str(exc_info.value)


def test_emit_returns_valid_json():
    """emit should return valid JSON string."""
    report = {"n_clusters": 8, "metric": 0.95}

    json_str = evidence.emit(
        report,
        analysis="cluster",
        identifier="test_run"
    )

    # Should be valid JSON
    parsed = json.loads(json_str)
    assert parsed["analysis"] == "cluster"
    assert parsed["identifier"] == "test_run"
    assert parsed["report"] == report


def test_emit_roundtrip():
    """emit output should roundtrip through json.loads."""
    report = {
        "n_obs": 5000,
        "n_vars": 2000,
        "params": {"resolution": 1.0, "n_neighbors": 15}
    }

    json_str = evidence.emit(
        report,
        analysis="preprocess",
        identifier="run_001"
    )

    # Parse back
    parsed = json.loads(json_str)

    # Verify structure
    assert parsed["schema"] == evidence.SCHEMA_VERSION
    assert parsed["kind"] == evidence.EVIDENCE_KIND
    assert parsed["analysis"] == "preprocess"
    assert parsed["identifier"] == "run_001"
    assert parsed["report"] == report


def test_emit_compact_no_whitespace():
    """emit_compact should produce compact JSON."""
    report = {"a": 1, "b": 2}

    regular = evidence.emit(report, analysis="test", identifier="id1")
    compact = evidence.emit_compact(report, analysis="test", identifier="id1")

    # Compact should be shorter (no extra whitespace)
    assert len(compact) <= len(regular)
    # Both should parse to same structure (ignoring timestamp which differs by microseconds)
    reg_parsed = json.loads(regular)
    cmp_parsed = json.loads(compact)
    assert reg_parsed["report"] == cmp_parsed["report"]
    assert reg_parsed["analysis"] == cmp_parsed["analysis"]
    assert reg_parsed["identifier"] == cmp_parsed["identifier"]


def test_shape_row_complex_report():
    """shape_row should handle complex nested reports."""
    report = {
        "n_clusters": 12,
        "cluster_sizes": [450, 320, 180, 150],
        "metrics": {
            "silhouette": 0.65,
            "davies_bouldin": 1.2,
        },
        "params": {
            "resolution": 1.0,
            "n_neighbors": 15,
            "seed": 42,
        },
        "genes": ["GAPDH", "ACTB", "CD3D"],
    }

    row = evidence.shape_row(
        report,
        analysis="cluster_analysis",
        identifier="leiden_full"
    )

    assert row["report"] == report
    # Should be JSON-serializable
    json_str = json.dumps(row)
    roundtrip = json.loads(json_str)
    assert roundtrip["report"] == report


def test_constants():
    """Verify evidence constants are correct."""
    assert evidence.EVIDENCE_KIND == "computation"
    assert evidence.SCHEMA_VERSION == 1
    assert isinstance(evidence.EVIDENCE_KIND, str)
    assert isinstance(evidence.SCHEMA_VERSION, int)


def test_emit_preserves_unicode():
    """emit should preserve Unicode characters."""
    report = {"description": "分析结果", "marker": "β-actin"}

    json_str = evidence.emit(
        report,
        analysis="test",
        identifier="unicode_test"
    )

    parsed = json.loads(json_str)
    assert parsed["report"]["description"] == "分析结果"
    assert parsed["report"]["marker"] == "β-actin"
