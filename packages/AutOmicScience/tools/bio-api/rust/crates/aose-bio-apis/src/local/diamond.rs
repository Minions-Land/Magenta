//! Local protein/translated alignment search (`gget diamond` equivalent), pure Rust.
//!
//! `gget diamond` shells out to the DIAMOND binary to align query sequences
//! against a reference set (BLAST-like, but fast). We replace it with all-pairs
//! **local alignment** using the Smith-Waterman aligner
//! ([`smith_waterman`](crate::local::pairwise::smith_waterman)): every query is
//! aligned against every reference, and hits passing an identity/score threshold
//! are returned, sorted by descending score.
//!
//! ## Algorithm
//!
//! For `q` queries and `r` references this performs `q*r` Smith-Waterman
//! alignments, each `O(n*m)`. Each surviving hit reports percent identity,
//! alignment length, raw score, and the aligned region bounds.
//!
//! ## Limitations
//!
//! * Exact Smith-Waterman, not DIAMOND's seed-and-extend heuristic — correct but
//!   `O(q*r*n*m)`, so intended for small reference sets (the realistic
//!   `gget diamond` use of aligning a few sequences against each other), not
//!   genome-scale databases.
//! * Linear gap penalty and identity scoring (no BLOSUM62, no affine gaps, no
//!   e-value statistics). Score is the raw SW score, not a bit score.

use crate::error::{BioApiError, BioApiResult};
use crate::local::pairwise::{smith_waterman, Scoring};

/// A single query-vs-reference local alignment hit.
#[derive(Debug, Clone)]
pub struct DiamondHit {
    /// Query sequence identifier.
    pub query_id: String,
    /// Reference (target) sequence identifier.
    pub target_id: String,
    /// Percent identity over the aligned region (0.0..=100.0).
    pub identity: f64,
    /// Raw Smith-Waterman alignment score.
    pub score: i32,
    /// Alignment length (number of aligned columns, including gaps).
    pub length: usize,
    /// Number of identical aligned columns.
    pub matches: usize,
    /// 0-based start of the aligned region in the query.
    pub query_start: usize,
    /// 0-based end (exclusive) of the aligned region in the query.
    pub query_end: usize,
    /// 0-based start of the aligned region in the target.
    pub target_start: usize,
    /// 0-based end (exclusive) of the aligned region in the target.
    pub target_end: usize,
}

/// Thresholds for reporting a hit.
#[derive(Debug, Clone, Copy)]
pub struct DiamondParams {
    /// Minimum percent identity to report (default 30.0, like a sensible BLAST cutoff).
    pub min_identity: f64,
    /// Minimum raw alignment score to report (default 1, i.e. any positive hit).
    pub min_score: i32,
}

impl Default for DiamondParams {
    fn default() -> Self {
        DiamondParams {
            min_identity: 30.0,
            min_score: 1,
        }
    }
}

/// Align every query against every reference, returning hits above the
/// thresholds, sorted by descending score then descending identity.
///
/// Fails loud on empty query or reference sets, or any empty sequence.
pub fn search(
    queries: &[(String, String)],
    references: &[(String, String)],
    params: DiamondParams,
) -> BioApiResult<Vec<DiamondHit>> {
    if queries.is_empty() {
        return Err(BioApiError::InvalidInput(
            "diamond: no query sequences provided".to_string(),
        ));
    }
    if references.is_empty() {
        return Err(BioApiError::InvalidInput(
            "diamond: no reference sequences provided".to_string(),
        ));
    }
    for (id, s) in queries.iter().chain(references.iter()) {
        if s.trim().is_empty() {
            return Err(BioApiError::InvalidInput(format!(
                "diamond: sequence '{id}' is empty"
            )));
        }
    }

    let sc = Scoring::default();
    let mut hits = Vec::new();

    for (qid, qseq) in queries {
        for (tid, tseq) in references {
            let aln = smith_waterman(qseq.as_bytes(), tseq.as_bytes(), sc);
            if aln.columns() == 0 {
                continue;
            }
            let identity = aln.percent_identity();
            if aln.score < params.min_score || identity < params.min_identity {
                continue;
            }
            hits.push(DiamondHit {
                query_id: qid.clone(),
                target_id: tid.clone(),
                identity,
                score: aln.score,
                length: aln.columns(),
                matches: aln.matches(),
                query_start: aln.start_a,
                query_end: aln.end_a,
                target_start: aln.start_b,
                target_end: aln.end_b,
            });
        }
    }

    hits.sort_by(|a, b| {
        b.score.cmp(&a.score).then(
            b.identity
                .partial_cmp(&a.identity)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn finds_high_identity_self_match() {
        // Reference contains the query verbatim -> 100% identity hit.
        let q = pairs(&[("q1", "MKTAYIAKQR")]);
        let r = pairs(&[
            ("ref_match", "XXXMKTAYIAKQRXXX"),
            ("ref_other", "GGGGGGGGGGGG"),
        ]);
        let hits = search(&q, &r, DiamondParams::default()).unwrap();
        assert!(!hits.is_empty());
        let top = &hits[0];
        assert_eq!(top.target_id, "ref_match");
        assert!(
            (top.identity - 100.0).abs() < 1e-9,
            "identity {}",
            top.identity
        );
        assert_eq!(top.matches, 10);
        // The unrelated reference should not pass the identity threshold.
        assert!(hits.iter().all(|h| h.target_id != "ref_other"));
    }

    #[test]
    fn unrelated_pair_no_hit() {
        let q = pairs(&[("q", "AAAAAAAAAA")]);
        let r = pairs(&[("r", "WWWWWWWWWW")]);
        let hits = search(&q, &r, DiamondParams::default()).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn empty_query_fails() {
        let err = search(&[], &pairs(&[("r", "ACGT")]), DiamondParams::default()).unwrap_err();
        assert!(err.to_string().contains("no query"));
    }

    #[test]
    fn empty_reference_fails() {
        let err = search(&pairs(&[("q", "ACGT")]), &[], DiamondParams::default()).unwrap_err();
        assert!(err.to_string().contains("no reference"));
    }
}
