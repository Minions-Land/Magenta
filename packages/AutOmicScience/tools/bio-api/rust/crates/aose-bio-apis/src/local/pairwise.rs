//! Pairwise sequence alignment primitives (pure Rust, no external deps).
//!
//! Implements the two textbook dynamic-programming aligners used by the local
//! `muscle` (MSA) and `diamond` (search) modules:
//!
//! * [`needleman_wunsch`] — global alignment (end-to-end), used by center-star MSA.
//! * [`smith_waterman`] — local alignment (best sub-region), used by diamond search.
//!
//! Scoring uses a simple linear gap model (constant penalty per gap column). This
//! is correct and deterministic for the small input sets these modules target; it
//! does not use an affine gap penalty or a substitution matrix (e.g. BLOSUM62).
//! See module docs in `muscle.rs` / `diamond.rs` for the resulting limitations.
//!
//! Complexity: O(n*m) time and space for sequences of length n and m.

/// Linear-gap scoring scheme for pairwise alignment.
#[derive(Debug, Clone, Copy)]
pub struct Scoring {
    /// Reward added for a matching column (positive).
    pub match_score: i32,
    /// Penalty added for a mismatching column (negative).
    pub mismatch: i32,
    /// Penalty added per gap column (negative).
    pub gap: i32,
}

impl Default for Scoring {
    /// Default scheme suitable for nucleotide and protein identity scoring.
    fn default() -> Self {
        Scoring {
            match_score: 2,
            mismatch: -1,
            gap: -2,
        }
    }
}

/// Result of a pairwise alignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alignment {
    /// Optimal alignment score under the supplied scheme.
    pub score: i32,
    /// Query (sequence `a`) with gap bytes (`b'-'`) inserted.
    pub aligned_a: Vec<u8>,
    /// Target (sequence `b`) with gap bytes (`b'-'`) inserted.
    pub aligned_b: Vec<u8>,
    /// 0-based start offset of the aligned region in `a` (always 0 for global).
    pub start_a: usize,
    /// 0-based start offset of the aligned region in `b` (always 0 for global).
    pub start_b: usize,
    /// 0-based end offset (exclusive) of the aligned region in `a`.
    pub end_a: usize,
    /// 0-based end offset (exclusive) of the aligned region in `b`.
    pub end_b: usize,
}

impl Alignment {
    /// Number of aligned columns where both residues are present and identical.
    pub fn matches(&self) -> usize {
        self.aligned_a
            .iter()
            .zip(self.aligned_b.iter())
            .filter(|(x, y)| x == y && **x != b'-')
            .count()
    }

    /// Total number of aligned columns (alignment length, including gaps).
    pub fn columns(&self) -> usize {
        self.aligned_a.len()
    }

    /// Percent identity over the aligned columns (0.0..=100.0). Returns 0.0 for
    /// an empty alignment.
    pub fn percent_identity(&self) -> f64 {
        let cols = self.columns();
        if cols == 0 {
            return 0.0;
        }
        (self.matches() as f64 / cols as f64) * 100.0
    }
}

// Traceback direction markers.
const DIAG: u8 = 0;
const UP: u8 = 1; // gap in b (consume a)
const LEFT: u8 = 2; // gap in a (consume b)
const STOP: u8 = 3; // local-alignment origin

/// Global (Needleman-Wunsch) alignment of `a` against `b`.
///
/// Aligns the full length of both sequences end-to-end. Positions are 0-based;
/// `start_*` is always 0 and `end_*` is the full length.
pub fn needleman_wunsch(a: &[u8], b: &[u8], sc: Scoring) -> Alignment {
    let n = a.len();
    let m = b.len();
    let w = m + 1;
    let mut score = vec![0i32; (n + 1) * w];
    let mut trace = vec![DIAG; (n + 1) * w];

    // Initialise first row/column with cumulative gap penalties.
    for j in 1..=m {
        score[j] = sc.gap * j as i32;
        trace[j] = LEFT;
    }
    for i in 1..=n {
        score[i * w] = sc.gap * i as i32;
        trace[i * w] = UP;
    }

    for i in 1..=n {
        for j in 1..=m {
            let s = if a[i - 1] == b[j - 1] {
                sc.match_score
            } else {
                sc.mismatch
            };
            let diag = score[(i - 1) * w + (j - 1)] + s;
            let up = score[(i - 1) * w + j] + sc.gap;
            let left = score[i * w + (j - 1)] + sc.gap;

            let (best, dir) = max3(diag, up, left);
            score[i * w + j] = best;
            trace[i * w + j] = dir;
        }
    }

    let mut aligned_a = Vec::new();
    let mut aligned_b = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        match trace[i * w + j] {
            DIAG if i > 0 && j > 0 => {
                aligned_a.push(a[i - 1]);
                aligned_b.push(b[j - 1]);
                i -= 1;
                j -= 1;
            }
            UP if i > 0 => {
                aligned_a.push(a[i - 1]);
                aligned_b.push(b'-');
                i -= 1;
            }
            LEFT if j > 0 => {
                aligned_a.push(b'-');
                aligned_b.push(b[j - 1]);
                j -= 1;
            }
            // Boundary fallbacks when only one sequence remains.
            _ if i > 0 => {
                aligned_a.push(a[i - 1]);
                aligned_b.push(b'-');
                i -= 1;
            }
            _ => {
                aligned_a.push(b'-');
                aligned_b.push(b[j - 1]);
                j -= 1;
            }
        }
    }
    aligned_a.reverse();
    aligned_b.reverse();

    Alignment {
        score: score[n * w + m],
        aligned_a,
        aligned_b,
        start_a: 0,
        start_b: 0,
        end_a: n,
        end_b: m,
    }
}

/// Local (Smith-Waterman) alignment of `a` against `b`.
///
/// Finds the highest-scoring local sub-alignment. The returned `aligned_*`
/// cover only the aligned region; `start_*`/`end_*` give its 0-based bounds.
pub fn smith_waterman(a: &[u8], b: &[u8], sc: Scoring) -> Alignment {
    let n = a.len();
    let m = b.len();
    let w = m + 1;
    let mut score = vec![0i32; (n + 1) * w];
    let mut trace = vec![STOP; (n + 1) * w];

    let mut best_score = 0i32;
    let mut best_pos = (0usize, 0usize);

    for i in 1..=n {
        for j in 1..=m {
            let s = if a[i - 1] == b[j - 1] {
                sc.match_score
            } else {
                sc.mismatch
            };
            let diag = score[(i - 1) * w + (j - 1)] + s;
            let up = score[(i - 1) * w + j] + sc.gap;
            let left = score[i * w + (j - 1)] + sc.gap;

            let (mut best, mut dir) = max3(diag, up, left);
            if best <= 0 {
                best = 0;
                dir = STOP;
            }
            score[i * w + j] = best;
            trace[i * w + j] = dir;
            if best > best_score {
                best_score = best;
                best_pos = (i, j);
            }
        }
    }

    let mut aligned_a = Vec::new();
    let mut aligned_b = Vec::new();
    let (mut i, mut j) = best_pos;
    let (end_a, end_b) = (i, j);
    while i > 0 && j > 0 && trace[i * w + j] != STOP && score[i * w + j] > 0 {
        match trace[i * w + j] {
            DIAG => {
                aligned_a.push(a[i - 1]);
                aligned_b.push(b[j - 1]);
                i -= 1;
                j -= 1;
            }
            UP => {
                aligned_a.push(a[i - 1]);
                aligned_b.push(b'-');
                i -= 1;
            }
            LEFT => {
                aligned_a.push(b'-');
                aligned_b.push(b[j - 1]);
                j -= 1;
            }
            _ => break,
        }
    }
    aligned_a.reverse();
    aligned_b.reverse();

    Alignment {
        score: best_score,
        aligned_a,
        aligned_b,
        start_a: i,
        start_b: j,
        end_a,
        end_b,
    }
}

/// Return the maximum of the three DP moves and the traceback marker for it.
/// Ties prefer DIAG, then UP, then LEFT for deterministic output.
fn max3(diag: i32, up: i32, left: i32) -> (i32, u8) {
    let mut best = diag;
    let mut dir = DIAG;
    if up > best {
        best = up;
        dir = UP;
    }
    if left > best {
        best = left;
        dir = LEFT;
    }
    (best, dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_identical_sequences() {
        let aln = needleman_wunsch(b"ACGTACGT", b"ACGTACGT", Scoring::default());
        assert_eq!(aln.aligned_a, b"ACGTACGT");
        assert_eq!(aln.aligned_b, b"ACGTACGT");
        assert_eq!(aln.matches(), 8);
        assert!((aln.percent_identity() - 100.0).abs() < 1e-9);
        assert_eq!(aln.score, 16); // 8 matches * 2
    }

    #[test]
    fn global_inserts_gap() {
        // b is missing the middle 'G'; a gap must be opened in b.
        let aln = needleman_wunsch(b"ACGT", b"ACT", Scoring::default());
        assert_eq!(aln.aligned_a.len(), aln.aligned_b.len());
        assert_eq!(aln.aligned_a.len(), 4);
        assert!(aln.aligned_b.contains(&b'-'));
        assert_eq!(aln.matches(), 3);
    }

    #[test]
    fn local_finds_embedded_region() {
        // Query fully contained inside the reference -> 100% local identity.
        let aln = smith_waterman(b"GATTACA", b"TTTTGATTACATTTT", Scoring::default());
        assert_eq!(aln.aligned_a, b"GATTACA");
        assert_eq!(aln.matches(), 7);
        assert!((aln.percent_identity() - 100.0).abs() < 1e-9);
        assert_eq!(aln.start_b, 4);
        assert_eq!(aln.end_b, 11);
    }

    #[test]
    fn local_unrelated_scores_low() {
        let aln = smith_waterman(b"AAAAAAAA", b"TTTTTTTT", Scoring::default());
        // No positive-scoring sub-region exists.
        assert_eq!(aln.score, 0);
        assert_eq!(aln.matches(), 0);
    }
}
