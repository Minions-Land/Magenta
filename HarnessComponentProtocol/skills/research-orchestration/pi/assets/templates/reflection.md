# Reflection: Iteration [N]

Date: [YYYY-MM-DD HH:MM]

## Contract Checklist

Walk every assertion in `contract.md`:

| # | Assertion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | [text]    | PASS / FAIL / UNCLEAR | `artifacts/...` or trace line |
| 2 | [text]    | ...    | ... |
...

## Four-Axis Scores

Each axis is 0–1 with a one-line justification.

- **Correctness** (0–1): [score] — does it do the right thing?
  - Reason: [one sentence]

- **Coverage** (0–1): [score] — how much of the contract is satisfied?
  - Reason: [one sentence]

- **Rigor** (0–1): [score] — reproducible, provenance clear, evidence traceable?
  - Reason: [one sentence]

- **Format Compliance** (0–1): [score] — does the output match the requested schema/shape?
  - Reason: [one sentence]

**Total**: [sum/4, or weighted if one axis is critical]

## Biggest Gap

The single most important thing blocking a higher score:

[One paragraph: what is wrong, which trace/artifact shows it, what would fix it]

## Decision

- [ ] Contract satisfied — proceed to finalize
- [ ] Another iteration needed — return to PLAN
- [ ] Contract wrong — renegotiate, then PLAN
- [ ] Restart needed — same issue after 2 iterations, rebuild from scratch
- [ ] Blocker — cannot proceed without [X]
