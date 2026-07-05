//! Multiple sequence alignment (`gget muscle` equivalent), pure Rust.
//!
//! `gget muscle` shells out to the MUSCLE binary to align a set of sequences.
//! We replace it with a **center-star progressive MSA** built on the global
//! ([`needleman_wunsch`](crate::local::pairwise::needleman_wunsch)) pairwise
//! aligner. Center-star is the standard tractable heuristic for small input
//! sets, which is the realistic use case for `gget muscle` (a handful of
//! related sequences).
//!
//! ## Algorithm (center-star)
//!
//! 1. Pairwise-align every sequence to every other (`O(k^2)` alignments for
//!    `k` sequences, each `O(n*m)`), and pick the "center" sequence whose total
//!    pairwise score against all others is maximal.
//! 2. Progressively merge each remaining sequence onto the growing alignment by
//!    aligning it to the center, then propagating any new gaps the pairwise
//!    alignment introduced in the center into every already-aligned row ("once a
//!    gap, always a gap").
//! 3. All output rows are padded to equal length.
//!
//! ## Limitations
//!
//! * Heuristic, not optimal — center-star guarantees a bounded approximation but
//!   not the optimal sum-of-pairs alignment.
//! * Linear (not affine) gap penalty and identity-based scoring; no BLOSUM/PAM
//!   matrix. Fine for closely related small sets, less accurate for divergent
//!   protein families.
//! * Intended for small inputs (a few dozen sequences of modest length). The
//!   `O(k^2 * n^2)` cost grows quickly beyond that.

use crate::error::{BioApiError, BioApiResult};
use crate::local::pairwise::{needleman_wunsch, Scoring};

/// One aligned row of the MSA.
#[derive(Debug, Clone)]
pub struct AlignedSeq {
    /// Sequence identifier.
    pub id: String,
    /// Gapped, aligned sequence (all rows share the same length).
    pub aligned_sequence: String,
}

/// Full MSA result.
#[derive(Debug, Clone)]
pub struct MsaResult {
    /// Aligned rows, in input order.
    pub rows: Vec<AlignedSeq>,
    /// Per-column majority consensus (gap if gaps are the plurality).
    pub consensus: String,
    /// Alignment width (number of columns).
    pub width: usize,
    /// Identifier of the sequence chosen as the star center.
    pub center_id: String,
}

const GAP: u8 = b'-';

/// Build a center-star MSA from `(id, sequence)` pairs.
///
/// Fails loud on fewer than two sequences or any empty sequence.
pub fn align(input: &[(String, String)]) -> BioApiResult<MsaResult> {
    if input.len() < 2 {
        return Err(BioApiError::InvalidInput(format!(
            "muscle MSA requires at least 2 sequences, got {}",
            input.len()
        )));
    }
    for (id, seq) in input {
        if seq.trim().is_empty() {
            return Err(BioApiError::InvalidInput(format!(
                "muscle MSA: sequence '{id}' is empty"
            )));
        }
    }

    let seqs: Vec<Vec<u8>> = input.iter().map(|(_, s)| s.as_bytes().to_vec()).collect();
    let sc = Scoring::default();
    let k = seqs.len();

    // 1. Pick the center: sequence with the highest total pairwise score.
    let mut totals = vec![0i64; k];
    for i in 0..k {
        for j in (i + 1)..k {
            let a = needleman_wunsch(&seqs[i], &seqs[j], sc);
            totals[i] += a.score as i64;
            totals[j] += a.score as i64;
        }
    }
    let center = (0..k).max_by_key(|&i| totals[i]).unwrap_or(0);

    // 2. Progressive merge onto the center.
    // `profile` holds the current alignment rows; `center_row` tracks the index
    // of the center row inside `profile` so we can propagate gaps into it.
    let mut profile: Vec<Vec<u8>> = vec![seqs[center].clone()];
    let mut profile_ids: Vec<usize> = vec![center];

    for (idx, seq) in seqs.iter().enumerate().take(k) {
        if idx == center {
            continue;
        }
        // Align the new sequence to the CURRENT center row (gaps and all).
        let center_row = profile[0].clone();
        let center_ungapped: Vec<u8> = center_row.iter().copied().filter(|&c| c != GAP).collect();
        let aln = needleman_wunsch(&center_ungapped, seq, sc);

        // `aln.aligned_a` is the center (ungapped) re-gapped against the new seq.
        // We must re-introduce the center's PRE-EXISTING gaps, then propagate any
        // NEW gaps `aln` opened in the center into every existing profile row.
        merge_onto_profile(&mut profile, &aln.aligned_a, &aln.aligned_b);
        profile_ids.push(idx);
    }

    // Restore input order.
    let mut rows_by_input: Vec<Option<String>> = vec![None; k];
    for (row, &orig_idx) in profile.iter().zip(profile_ids.iter()) {
        rows_by_input[orig_idx] = Some(String::from_utf8_lossy(row).into_owned());
    }

    let width = profile.first().map(|r| r.len()).unwrap_or(0);
    let rows: Vec<AlignedSeq> = input
        .iter()
        .enumerate()
        .map(|(i, (id, _))| AlignedSeq {
            id: id.clone(),
            aligned_sequence: rows_by_input[i].clone().unwrap_or_default(),
        })
        .collect();

    let consensus = consensus_of(&rows, width);

    Ok(MsaResult {
        rows,
        consensus,
        width,
        center_id: input[center].0.clone(),
    })
}

/// Merge a freshly aligned (center, new) pair into the existing profile.
///
/// `new_center` is the center row re-gapped by the latest pairwise alignment
/// (its non-gap residues equal the center's ungapped residues). `new_seq` is the
/// new sequence aligned against it. We walk both the existing profile-center row
/// and `new_center` simultaneously; wherever `new_center` introduces a gap that
/// is not already present, we insert a gap column into every existing row.
fn merge_onto_profile(profile: &mut Vec<Vec<u8>>, new_center: &[u8], new_seq: &[u8]) {
    let old_center = profile[0].clone();
    let rows = profile.len();
    let mut merged: Vec<Vec<u8>> = vec![Vec::new(); rows + 1]; // +1 for the new seq

    let mut oi = 0; // index into old_center (existing profile columns)
    let mut ni = 0; // index into new_center / new_seq

    while oi < old_center.len() || ni < new_center.len() {
        let old_is_gap = oi < old_center.len() && old_center[oi] == GAP;
        // Existing profile has a gap column here that the new alignment doesn't
        // know about: emit it, gap the new sequence.
        if old_is_gap {
            for r in 0..rows {
                merged[r].push(profile[r][oi]);
            }
            merged[rows].push(GAP);
            oi += 1;
            continue;
        }

        let new_is_gap = ni < new_center.len() && new_center[ni] == GAP;
        if new_is_gap {
            // New alignment opened a gap in the center: insert a gap column into
            // all existing rows, take the new sequence residue.
            for row in &mut merged[..rows] {
                row.push(GAP);
            }
            merged[rows].push(new_seq[ni]);
            ni += 1;
            continue;
        }

        // Both sides consume a real center residue in lock-step.
        if oi < old_center.len() && ni < new_center.len() {
            for r in 0..rows {
                merged[r].push(profile[r][oi]);
            }
            merged[rows].push(new_seq[ni]);
            oi += 1;
            ni += 1;
        } else if oi < old_center.len() {
            for r in 0..rows {
                merged[r].push(profile[r][oi]);
            }
            merged[rows].push(GAP);
            oi += 1;
        } else {
            for row in &mut merged[..rows] {
                row.push(GAP);
            }
            merged[rows].push(new_seq[ni]);
            ni += 1;
        }
    }

    *profile = merged;
}

/// Majority-vote consensus across columns; gap wins ties only if it is the
/// strict plurality.
fn consensus_of(rows: &[AlignedSeq], width: usize) -> String {
    let mut out = String::with_capacity(width);
    let byte_rows: Vec<&[u8]> = rows.iter().map(|r| r.aligned_sequence.as_bytes()).collect();
    for col in 0..width {
        let mut counts: std::collections::HashMap<u8, usize> = std::collections::HashMap::new();
        for r in &byte_rows {
            if col < r.len() {
                *counts.entry(r[col]).or_insert(0) += 1;
            }
        }
        // Pick the residue with the highest count, preferring non-gap on ties.
        let best = counts
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then_with(|| (*a.0 != GAP).cmp(&(*b.0 != GAP))))
            .map(|(c, _)| *c)
            .unwrap_or(GAP);
        out.push(best as char);
    }
    out
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
    fn rejects_single_sequence() {
        let err = align(&pairs(&[("a", "ACGT")])).unwrap_err();
        assert!(err.to_string().contains("at least 2"));
    }

    #[test]
    fn rejects_empty_sequence() {
        let err = align(&pairs(&[("a", "ACGT"), ("b", "")])).unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn aligns_three_with_equal_width() {
        // b is missing the middle base of a; c has an extra base.
        let res = align(&pairs(&[
            ("s1", "ACGTACGT"),
            ("s2", "ACGTCGT"),
            ("s3", "ACGTAACGT"),
        ]))
        .unwrap();
        assert_eq!(res.rows.len(), 3);
        let w = res.rows[0].aligned_sequence.len();
        assert!(w >= 8);
        for r in &res.rows {
            assert_eq!(r.aligned_sequence.len(), w, "row {} wrong width", r.id);
        }
        assert_eq!(res.width, w);
        assert_eq!(res.consensus.len(), w);
        // Removing gaps must recover the original sequences.
        let ungap = |s: &str| s.replace('-', "");
        assert_eq!(ungap(&res.rows[0].aligned_sequence), "ACGTACGT");
        assert_eq!(ungap(&res.rows[1].aligned_sequence), "ACGTCGT");
        assert_eq!(ungap(&res.rows[2].aligned_sequence), "ACGTAACGT");
    }

    #[test]
    fn identical_sequences_no_gaps() {
        let res = align(&pairs(&[
            ("a", "MKTAYIA"),
            ("b", "MKTAYIA"),
            ("c", "MKTAYIA"),
        ]))
        .unwrap();
        for r in &res.rows {
            assert_eq!(r.aligned_sequence, "MKTAYIA");
        }
        assert_eq!(res.consensus, "MKTAYIA");
    }
}
