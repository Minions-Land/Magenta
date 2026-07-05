//! Local sequence mutation (`gget mutate` equivalent), pure Rust.
//!
//! Applies a list of mutations to input sequences and returns the mutant
//! sequences. Mutation notation follows the HGVS-style strings accepted by
//! `gget mutate`:
//!
//! * Substitution: `c.2T>C` or `g.2T>C` (1-based: base 2 must be `T`, becomes `C`).
//! * Plain substitution: `T2C` (1-based ref/pos/alt, no `c.`/`g.` prefix).
//! * Deletion: `c.2_4del` or `c.3del` (delete the inclusive 1-based range).
//! * Insertion: `c.2_3insAT` (insert `AT` between bases 2 and 3).
//! * Delins: `c.2_4delinsGG` (replace the range with `GG`).
//! * Duplication: `c.2_4dup` or `c.3dup` (duplicate the range immediately after).
//!
//! All coordinates are **1-based and inclusive**, matching HGVS / gget.
//!
//! For substitutions and deletions the reference base(s) given in the notation
//! are validated against the actual sequence; a mismatch returns an error naming
//! the position (fail loud, never silently apply).

use crate::error::{BioApiError, BioApiResult};

/// A single applied mutation result.
#[derive(Debug, Clone)]
pub struct MutationResult {
    /// Identifier of the source sequence the mutation was applied to.
    pub original_id: String,
    /// The mutation string that was applied.
    pub mutation: String,
    /// The resulting mutant sequence.
    pub mutated_sequence: String,
}

/// Parsed representation of a mutation operation (0-based, half-open `[start,end)`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Op {
    /// Substitute a single base. `pos` 0-based, `reference` and `alt` are bytes.
    Sub { pos: usize, reference: u8, alt: u8 },
    /// Delete bases in `[start, end)` (0-based half-open).
    Del { start: usize, end: usize },
    /// Insert `seq` after 0-based index `after` (between `after` and `after+1`).
    Ins { after: usize, seq: Vec<u8> },
    /// Replace `[start, end)` with `seq`.
    Delins {
        start: usize,
        end: usize,
        seq: Vec<u8>,
    },
    /// Duplicate `[start, end)` immediately after the range.
    Dup { start: usize, end: usize },
}

/// Apply a single mutation string to one sequence, returning the mutant.
///
/// `seq` is treated as a raw residue string (upper/lower preserved). Validation
/// of reference bases is case-insensitive; output preserves the inserted/alt
/// casing exactly as written in the mutation string.
pub fn apply_mutation(seq: &str, mutation: &str) -> BioApiResult<String> {
    let op = parse_mutation(mutation)?;
    let bytes = seq.as_bytes();
    let len = bytes.len();

    let out: Vec<u8> = match op {
        Op::Sub {
            pos,
            reference,
            alt,
        } => {
            check_pos(pos, len, mutation)?;
            check_ref(bytes[pos], reference, pos, mutation)?;
            let mut v = bytes.to_vec();
            v[pos] = alt;
            v
        }
        Op::Del { start, end } => {
            check_range(start, end, len, mutation)?;
            let mut v = Vec::with_capacity(len - (end - start));
            v.extend_from_slice(&bytes[..start]);
            v.extend_from_slice(&bytes[end..]);
            v
        }
        Op::Ins { after, seq: ins } => {
            // `after` is the 0-based left flank index; allow `after == len-1` up to
            // inserting at the very end is expressed via after = len-1.
            check_pos(after, len, mutation)?;
            let mut v = Vec::with_capacity(len + ins.len());
            v.extend_from_slice(&bytes[..=after]);
            v.extend_from_slice(&ins);
            v.extend_from_slice(&bytes[after + 1..]);
            v
        }
        Op::Delins {
            start,
            end,
            seq: ins,
        } => {
            check_range(start, end, len, mutation)?;
            let mut v = Vec::with_capacity(len - (end - start) + ins.len());
            v.extend_from_slice(&bytes[..start]);
            v.extend_from_slice(&ins);
            v.extend_from_slice(&bytes[end..]);
            v
        }
        Op::Dup { start, end } => {
            check_range(start, end, len, mutation)?;
            let mut v = Vec::with_capacity(len + (end - start));
            v.extend_from_slice(&bytes[..end]);
            v.extend_from_slice(&bytes[start..end]);
            v.extend_from_slice(&bytes[end..]);
            v
        }
    };

    String::from_utf8(out)
        .map_err(|e| BioApiError::InvalidInput(format!("mutated sequence not valid UTF-8: {e}")))
}

/// Apply a mutation and additionally return only the mutant region plus
/// `flank` residues of context on each side (the gget `flank_length` option).
pub fn apply_mutation_with_flank(seq: &str, mutation: &str, flank: usize) -> BioApiResult<String> {
    let full = apply_mutation(seq, mutation)?;
    let op = parse_mutation(mutation)?;
    // Determine the 0-based center index of the change in the MUTANT coordinates.
    let (center_start, center_end) = match op {
        Op::Sub { pos, .. } => (pos, pos + 1),
        Op::Del { start, .. } => (start, start), // deleted region collapses
        Op::Ins { after, seq: ins } => (after + 1, after + 1 + ins.len()),
        Op::Delins {
            start, seq: ins, ..
        } => (start, start + ins.len()),
        Op::Dup { start, end } => (end, end + (end - start)),
    };
    let bytes = full.as_bytes();
    let lo = center_start.saturating_sub(flank);
    let hi = (center_end + flank).min(bytes.len());
    Ok(String::from_utf8_lossy(&bytes[lo..hi]).into_owned())
}

fn check_pos(pos: usize, len: usize, mutation: &str) -> BioApiResult<()> {
    if pos >= len {
        return Err(BioApiError::InvalidInput(format!(
            "mutation '{mutation}': position {} is out of range for sequence of length {len}",
            pos + 1
        )));
    }
    Ok(())
}

fn check_range(start: usize, end: usize, len: usize, mutation: &str) -> BioApiResult<()> {
    if start >= end || end > len {
        return Err(BioApiError::InvalidInput(format!(
            "mutation '{mutation}': range {}..{} is out of bounds for sequence of length {len}",
            start + 1,
            end
        )));
    }
    Ok(())
}

fn check_ref(actual: u8, expected: u8, pos: usize, mutation: &str) -> BioApiResult<()> {
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(BioApiError::InvalidInput(format!(
            "mutation '{mutation}': reference mismatch at position {} — expected '{}' but sequence has '{}'",
            pos + 1,
            expected as char,
            actual as char
        )));
    }
    Ok(())
}

/// Parse an HGVS-style mutation string into a 0-based [`Op`].
fn parse_mutation(mutation: &str) -> BioApiResult<Op> {
    let raw = mutation.trim();
    if raw.is_empty() {
        return Err(BioApiError::InvalidInput(
            "empty mutation string".to_string(),
        ));
    }
    // Strip a leading reference-type prefix like `c.`, `g.`, `n.`, `m.`, `r.`.
    let body = strip_prefix(raw);

    // Insertion / delins / dup / del / substitution dispatch.
    if let Some(idx) = body.find("delins") {
        let (range, ins) = body.split_at(idx);
        let ins = &ins["delins".len()..];
        let (start, end) = parse_range(range, mutation)?;
        return Ok(Op::Delins {
            start,
            end,
            seq: ins.as_bytes().to_vec(),
        });
    }
    if let Some(idx) = body.find("ins") {
        // Insertion uses a two-position range `a_b` flanking the insert point.
        let (range, ins) = body.split_at(idx);
        let ins = &ins["ins".len()..];
        let (a, b) = parse_two_positions(range, mutation)?;
        if b != a + 1 {
            return Err(BioApiError::InvalidInput(format!(
                "mutation '{mutation}': insertion flanks must be adjacent (e.g. 2_3ins...)"
            )));
        }
        if ins.is_empty() {
            return Err(BioApiError::InvalidInput(format!(
                "mutation '{mutation}': insertion has no inserted sequence"
            )));
        }
        // `a` is 1-based left flank -> 0-based index a-1.
        return Ok(Op::Ins {
            after: a - 1,
            seq: ins.as_bytes().to_vec(),
        });
    }
    if let Some(range) = body.strip_suffix("dup") {
        let (start, end) = parse_range(range, mutation)?;
        return Ok(Op::Dup { start, end });
    }
    if let Some(range) = body.strip_suffix("del") {
        let (start, end) = parse_range(range, mutation)?;
        return Ok(Op::Del { start, end });
    }

    // Substitution: either `2T>C` (pos ref>alt) or `T2C` (ref pos alt).
    parse_substitution(body, mutation)
}

/// Strip a leading HGVS reference-type prefix (`c.`, `g.`, ...).
fn strip_prefix(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b'.' && bytes[0].is_ascii_alphabetic() {
        &s[2..]
    } else {
        s
    }
}

/// Parse a `start_end` or single-position range into 0-based half-open bounds.
fn parse_range(range: &str, mutation: &str) -> BioApiResult<(usize, usize)> {
    let range = range.trim();
    if let Some((a, b)) = range.split_once('_') {
        let start = parse_1based(a, mutation)?;
        let end = parse_1based(b, mutation)?;
        if end < start {
            return Err(BioApiError::InvalidInput(format!(
                "mutation '{mutation}': range end before start"
            )));
        }
        Ok((start - 1, end)) // 1-based inclusive -> 0-based half-open
    } else {
        let p = parse_1based(range, mutation)?;
        Ok((p - 1, p))
    }
}

/// Parse a two-position `a_b` range, returning the 1-based positions.
fn parse_two_positions(range: &str, mutation: &str) -> BioApiResult<(usize, usize)> {
    let (a, b) = range.trim().split_once('_').ok_or_else(|| {
        BioApiError::InvalidInput(format!(
            "mutation '{mutation}': insertion requires two flanking positions (e.g. 2_3ins...)"
        ))
    })?;
    Ok((parse_1based(a, mutation)?, parse_1based(b, mutation)?))
}

fn parse_1based(s: &str, mutation: &str) -> BioApiResult<usize> {
    let n: usize = s.trim().parse().map_err(|_| {
        BioApiError::InvalidInput(format!(
            "mutation '{mutation}': '{s}' is not a valid position"
        ))
    })?;
    if n == 0 {
        return Err(BioApiError::InvalidInput(format!(
            "mutation '{mutation}': positions are 1-based, got 0"
        )));
    }
    Ok(n)
}

/// Parse a single substitution in either `2T>C` or `T2C` form.
fn parse_substitution(body: &str, mutation: &str) -> BioApiResult<Op> {
    // Form A: `<pos><ref>><alt>` e.g. `2T>C`.
    if let Some((lhs, alt)) = body.split_once('>') {
        let alt = alt.trim();
        if alt.len() != 1 {
            return Err(BioApiError::InvalidInput(format!(
                "mutation '{mutation}': substitution alt must be a single residue"
            )));
        }
        let lhs = lhs.trim();
        // Split trailing reference letter from leading digits.
        let split = lhs
            .char_indices()
            .find(|(_, c)| c.is_ascii_alphabetic())
            .map(|(i, _)| i)
            .ok_or_else(|| {
                BioApiError::InvalidInput(format!(
                    "mutation '{mutation}': substitution missing reference residue"
                ))
            })?;
        let (digits, reference) = lhs.split_at(split);
        if reference.len() != 1 {
            return Err(BioApiError::InvalidInput(format!(
                "mutation '{mutation}': substitution reference must be a single residue"
            )));
        }
        let pos = parse_1based(digits, mutation)?;
        return Ok(Op::Sub {
            pos: pos - 1,
            reference: reference.as_bytes()[0],
            alt: alt.as_bytes()[0],
        });
    }

    // Form B: `<ref><pos><alt>` e.g. `T2C`.
    let bytes = body.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[bytes.len() - 1].is_ascii_alphabetic()
    {
        let reference = bytes[0];
        let alt = bytes[bytes.len() - 1];
        let digits = &body[1..body.len() - 1];
        if digits.chars().all(|c| c.is_ascii_digit()) && !digits.is_empty() {
            let pos = parse_1based(digits, mutation)?;
            return Ok(Op::Sub {
                pos: pos - 1,
                reference,
                alt,
            });
        }
    }

    Err(BioApiError::InvalidInput(format!(
        "mutation '{mutation}': unrecognized mutation notation"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution_hgvs_form() {
        // c.2T>C : base 2 ('T') -> 'C'
        let out = apply_mutation("ATGC", "c.2T>C").unwrap();
        assert_eq!(out, "ACGC");
    }

    #[test]
    fn substitution_plain_form() {
        // T2C : same as above without prefix
        let out = apply_mutation("ATGC", "T2C").unwrap();
        assert_eq!(out, "ACGC");
    }

    #[test]
    fn substitution_ref_mismatch_fails_loud() {
        // base 2 is 'T', not 'A' -> must error and name the position
        let err = apply_mutation("ATGC", "c.2A>C").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("position 2"), "msg was: {msg}");
        assert!(msg.contains("reference mismatch"), "msg was: {msg}");
    }

    #[test]
    fn deletion_range() {
        // c.2_3del : delete bases 2-3 ('TG') from ATGC -> AC
        let out = apply_mutation("ATGC", "c.2_3del").unwrap();
        assert_eq!(out, "AC");
    }

    #[test]
    fn single_deletion() {
        let out = apply_mutation("ATGC", "c.3del").unwrap();
        assert_eq!(out, "ATC");
    }

    #[test]
    fn insertion() {
        // c.2_3insTT : insert TT between base 2 and 3 -> AT TT GC
        let out = apply_mutation("ATGC", "c.2_3insTT").unwrap();
        assert_eq!(out, "ATTTGC");
    }

    #[test]
    fn delins() {
        // c.2_3delinsAA : replace bases 2-3 with AA -> A AA C
        let out = apply_mutation("ATGC", "c.2_3delinsAA").unwrap();
        assert_eq!(out, "AAAC");
    }

    #[test]
    fn duplication() {
        // c.2_3dup : duplicate bases 2-3 ('TG') after them -> AT TG TG C
        let out = apply_mutation("ATGC", "c.2_3dup").unwrap();
        assert_eq!(out, "ATGTGC");
    }

    #[test]
    fn out_of_range_fails() {
        let err = apply_mutation("ATGC", "c.9T>C").unwrap_err();
        assert!(err.to_string().contains("out of range"));
    }

    #[test]
    fn flank_extracts_context() {
        // long sequence, substitution at pos 10, flank 3 -> 7 residues window
        let seq = "AAAAAAAAATGAAAAAAAA"; // pos 10 is 'T'
        let out = apply_mutation_with_flank(seq, "c.10T>C", 3).unwrap();
        assert_eq!(out, "AAACGAA");
        assert_eq!(out.len(), 7); // 3 + 1 + 3
    }
}
