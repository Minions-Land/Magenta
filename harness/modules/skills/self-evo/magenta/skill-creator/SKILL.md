---
name: self-evo-skill-creator
disable-model-invocation: true
---

# Sub-skill: Skill Creator (Create and Improve Magenta Skills)

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill when the user wants to create a new skill, modify an
> existing skill, or optimize skill performance.

This sub-skill helps create **Skills** as one of Magenta's four primitives
(alongside Tools, Capabilities, and Resources). Skills are specialized
instruction sets that guide the agent through complex, domain-specific workflows.

---

## What is a Skill in Magenta?

A Skill is a **Resource primitive** containing structured instructions for the
agent. Unlike Claude's skills (which are invoked by the model), Magenta skills
are **loaded into context** when matched and provide:

- Domain-specific workflows and best practices
- Step-by-step procedures
- Examples and templates
- References to relevant tools and capabilities

**Key differences from Claude skills:**
- Magenta skills are **Resources** (content-only, no code builder)
- Loaded via pattern matching in `description` field
- Can reference bundled assets, scripts, and documentation
- Must follow Magenta's module structure

---

## When to Create a Skill

Create a skill when:
- There's a recurring complex workflow that benefits from structured guidance
- Domain expertise needs to be captured (e.g., paper-analysis, pptx, research)
- The task involves multiple steps with specific ordering or dependencies
- Examples and templates significantly improve output quality

**Don't create a skill when:**
- A simple Tool would suffice (single function, objectively verifiable)
- The task is one-off or highly variable
- Instructions would be trivial (< 50 lines)

---

## The Skill Creation Loop

At a high level:

1. **Capture Intent** — What workflow does this skill enable?
2. **Interview and Research** — Understand edge cases, examples, success criteria
3. **Write the SKILL.md** — Draft the structured instructions
4. **Create Test Cases** — Realistic prompts that should trigger the skill
5. **Run and Evaluate** — Test with sub-agents, gather feedback
6. **Iterate** — Improve based on qualitative feedback and test results
7. **Gate and Register** — Verify structure and register in harness

Your job is to guide the user through these stages, adapting the pace to their
familiarity and needs. Some users want rigorous testing; others prefer to "vibe"
with quick iterations.

---

## Step 1: Capture Intent

Start by understanding what the user wants. The current conversation may already
contain a workflow they want to capture. If so, extract from history first.

**Key questions:**
1. What should this skill enable Magenta to do?
2. When should this skill load? (What user phrases/contexts trigger it?)
3. What domain expertise or workflow steps are involved?
4. What's the expected output format or success criteria?
5. Should we set up test cases? (Recommended for skills with verifiable workflows)

**Communicate clearly:** Gauge the user's technical level. Terms like "YAML
frontmatter", "sub-agent", "assertion" may need brief explanation for
non-technical users.

---

## Step 2: Interview and Research

Proactively ask about:
- Edge cases and common failure modes
- Input/output formats and examples
- Success criteria and quality standards
- Dependencies (tools, files, external services)
- Existing similar workflows to learn from

**Research in parallel:** If useful, spawn sub-agents to:
- Search Magenta docs for similar skills or patterns
- Review existing skills in `harness/modules/skills/`
- Find relevant tools in `harness/modules/tools/`
- Look up best practices or domain conventions

Come prepared with context to reduce burden on the user.

---

## Step 3: Write the SKILL.md

### Location and Structure

```
harness/modules/skills/<skill-name>/
├── <source>/              (e.g., magenta/, pi/, codex/)
│   └── SKILL.md           (required)
│       ├── YAML frontmatter
│       └── Markdown instructions
└── assets/ (optional)
    ├── scripts/           - Executable helpers
    ├── references/        - Docs loaded as needed
    └── templates/         - Output templates
```

**Source discipline:** The `<source>` directory reflects the skill's origin:
- `magenta/` — created by Magenta for Magenta
- `pi/` — converted from Claude Code/Pi extension
- `codex/` — from GitHub Copilot
- Never mislabel provenance

### YAML Frontmatter (Required)

```yaml
---
name: skill-name
description: >
  When to use this skill and what it does. This is the PRIMARY TRIGGERING
  MECHANISM. Include both the capability AND specific contexts. Be slightly
  "pushy" to combat undertriggering — mention related keywords and scenarios.
  
  Example: "Deeply analyze academic papers. Use when the user provides a PDF,
  arXiv/DOI/link, abstract, or pasted paper text and asks to analyze, explain,
  summarize, review, critique, reproduce, compare, extract contributions,
  understand methods/experiments, or prepare literature notes/slides for a
  research paper."
---
```

**Description best practices:**
- Combine "what it does" + "when to use it"
- Include trigger keywords and related terms
- Be specific about input types and contexts
- Slightly over-inclusive to ensure triggering

### Skill Body Structure

Use **progressive disclosure** (three-level loading):

1. **Metadata** (name + description) — Always in context (~100 words)
2. **SKILL.md body** — Loaded when skill triggers (<500 lines ideal)
3. **Bundled resources** — Loaded as needed (unlimited)

**Recommended structure:**

```markdown
# [Skill Name]

Brief overview of what this skill does and when to use it.

## 1. Input Check (if applicable)

What inputs are required? What to do if missing?

## 2. Core Workflow

Step-by-step procedure. Use numbered lists for sequential steps.

### 2.1 Sub-step Name

Details, examples, code snippets.

## 3. Output Format

What should the final result look like? Templates or examples.

## 4. Quality Requirements

Standards, validation checks, common pitfalls to avoid.

## 5. Examples (optional but recommended)

**Example 1: [Descriptive name]**
Input: [...]
Output: [...]

## 6. References (if large docs exist)

See `references/domain-guide.md` for [specific topic].
```

### Writing Style

- **Use imperative form**: "Extract the title" not "You should extract the title"
- **Explain the why**: Help the agent understand reasoning, not just rules
- **Be specific but flexible**: Provide structure without being rigid
- **Include examples**: Real-world scenarios help immensely
- **Keep it under 500 lines**: If approaching this, split into sub-topics with
  clear pointers to `references/` files

**Avoid:**
- Heavy-handed MUSTs and NEVERs in all caps (except for critical requirements)
- Overly rigid structures that don't allow flexibility
- Jargon without brief explanation
- Assuming the agent knows domain-specific conventions

---

## Step 4: Create Test Cases

After drafting the skill, create 2-3 realistic test prompts — the kind a real
user would actually type. These should be:
- Specific and detailed (not abstract)
- Cover different aspects of the skill
- Include edge cases or common variations

**Good test prompts:**
- "I have a PDF of a machine learning paper on arXiv (2401.12345). Can you
  analyze the methodology and tell me if the results are reproducible?"
- "Create a presentation deck from this markdown outline. It needs to look
  professional and be under 10 slides."

**Bad test prompts:**
- "Analyze a paper" (too vague)
- "Make slides" (no context or requirements)

Share test prompts with the user: "Here are test cases I'd like to try. Do these
look right, or should we add more?"

---

## Step 5: Run and Evaluate (with Sub-agents)

This is a continuous sequence. Don't stop partway through.

### Workspace Organization

```
<skill-name>-workspace/
├── skill-snapshot/          (if improving existing skill)
└── iteration-1/
    ├── eval-0-descriptive-name/
    │   ├── with_skill/
    │   │   ├── outputs/     (files produced by the skill)
    │   │   ├── timing.json
    │   │   └── transcript.txt (if available)
    │   ├── without_skill/   (baseline: no skill)
    │   │   └── outputs/
    │   └── eval_metadata.json
    ├── eval-1-another-case/
    │   └── ...
    └── feedback.json        (user's qualitative feedback)
```

### 5.1 Spawn All Runs (Parallel)

For each test case, spawn **two sub-agents simultaneously**:

**With-skill run:**
```
Execute this task with the new skill loaded:
- Skill path: <path-to-skill>/SKILL.md
- Task: <eval prompt>
- Input files: <if any, or "none">
- Save outputs to: <workspace>/iteration-1/eval-<N>/with_skill/outputs/
- Capture: the final deliverables (e.g., .docx, .pdf, final analysis)
```

**Baseline run** (choose based on context):
- **New skill:** No skill at all. Save to `without_skill/outputs/`
- **Improving existing:** Snapshot the old version first, use it as baseline

Create `eval_metadata.json` for each test case:

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "expected_outcome": "What success looks like",
  "assertions": []
}
```

### 5.2 Capture Timing Data

When each sub-agent completes, you receive `total_tokens` and `duration_ms` in
the task notification. **Save immediately** to `timing.json`:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

This is the only chance to capture this data.

### 5.3 Qualitative Review

Since Magenta doesn't have Claude's eval-viewer infrastructure, use a **manual
review workflow**:

1. **Present outputs to the user:** For each test case, show:
   - The prompt
   - The with-skill output (rendered or described)
   - The baseline output for comparison
   - Timing data (tokens, duration)

2. **Ask for feedback:** "How does this look? Anything you'd change?"

3. **Record feedback:** Save to `feedback.json`:
   ```json
   {
     "reviews": [
       {
         "eval_name": "paper-analysis-test",
         "with_skill_feedback": "Good structure but missing related work section",
         "baseline_feedback": "Too brief, no methodology analysis",
         "verdict": "skill is better but needs improvement"
       }
     ],
     "status": "complete"
   }
   ```

### 5.4 Optional: Quantitative Assertions

For skills with objectively verifiable outputs, you can add assertions:

```json
"assertions": [
  {
    "name": "Contains all required sections",
    "check": "Output includes: title, abstract, method, results, conclusion"
  },
  {
    "name": "Output format is correct",
    "check": "File is valid .docx and opens without errors"
  }
]
```

Grade these programmatically when possible (scripts > eyeballing).

---

## Step 6: Improve the Skill

This is the heart of the loop. Based on feedback, improve the skill.

### How to Think About Improvements

1. **Generalize from feedback:** These test cases are training examples. The
   skill will be used millions of times. Don't overfit to specific examples —
   look for patterns and underlying principles.

2. **Keep it lean:** Remove instructions that aren't pulling their weight. If
   transcripts show the agent wasting time on unproductive tasks, trim those
   parts.

3. **Explain the why:** LLMs are smart and have good theory of mind. Instead of
   rigid ALWAYS/NEVER rules, explain the reasoning so the agent understands why
   something matters.

4. **Look for repeated work:** If all test runs independently wrote similar
   helper scripts (e.g., `create_docx.py`, `parse_bibtex.py`), bundle those
   scripts in `assets/scripts/` and instruct the skill to use them. Save future
   invocations from reinventing the wheel.

**Process:**
- Write a draft revision
- Step back and look at it with fresh eyes
- Make improvements
- Consider alternate approaches or metaphors if something is stubborn

### The Iteration Loop

1. Apply improvements to SKILL.md
2. Rerun all test cases into `iteration-2/`
3. Compare with `iteration-1/` outputs
4. Get user feedback
5. Repeat until satisfied

**Stopping criteria:**
- User says they're happy
- Feedback is consistently empty (everything looks good)
- Not making meaningful progress

---

## Step 7: Gate and Register

Before landing the skill, run Magenta's verification gates:

```bash
cd /Users/mjm/Magenta3/harness

# Build and verify
npm run build                # Must be green
npm test                     # No regressions
npm run check:structure      # Enforces module layout rules
npm run inspect              # Confirm skill resolves correctly
```

### Register in harness.toml

Add the skill to `harness/harness.toml`:

```toml
[[components]]
kind = "skill"
name = "skill-name"
source = "magenta"  # or "pi", "codex", etc.
path = "modules/skills/skill-name"
```

### Verify Registration

```bash
npm run inspect | grep -A 5 "skill-name"
```

Confirm the skill appears in the registry and has no warnings.

---

## Advanced: Description Optimization

After creating the skill, you can optimize the `description` field to improve
triggering accuracy. This is optional but recommended for skills that compete
with others or have subtle triggers.

**Process:**
1. Generate 20 test queries (10 should-trigger, 10 should-not-trigger)
2. Make them realistic and detailed (not abstract)
3. Test current description: how many queries trigger correctly?
4. Propose improved description based on failures
5. Test again, iterate up to 5 times
6. Use held-out test set to avoid overfitting

**Should-trigger queries** — Different phrasings of valid use cases:
- Formal and casual variants
- Implicit needs (user doesn't name the skill explicitly)
- Uncommon but valid use cases

**Should-not-trigger queries** — Near misses that share keywords but need
something different:
- Adjacent domains
- Ambiguous phrasing
- Cases where another skill/tool is more appropriate

**Key:** Negative cases should be genuinely tricky, not obviously irrelevant.

---

## Magenta-Specific Guidelines

### Skills are Resources, Not Capabilities

- Skills have **no code builder** — they're content-only
- Never add a skill to `CAPABILITY_KINDS`
- Use `content_path` in the descriptor, not `exports.factory`

### Source Discipline

The `<source>` directory reflects origin:
- Created by Magenta → `magenta/`
- Converted from Claude → `pi/`
- From external agent → tag with origin

Never mislabel provenance with `magenta` just because Magenta did the
integration.

### One-of Invariant

A skill should focus on **one domain or workflow**. If you find yourself creating
multiple distinct sub-workflows, consider:
- Splitting into separate skills
- Using a skill that routes to reference docs for each variant

### Preserve Existing Names

When improving an existing skill:
- Keep the original directory name and frontmatter `name`
- Don't append `-v2` or version numbers
- Edit in place (or copy to writable location if needed)

---

## Cowork / Headless Environments

If running in Cowork or a headless environment:
- Sub-agents work normally
- No browser-based viewer — use manual review
- Present outputs directly in conversation
- Ask for feedback inline
- Save feedback to `feedback.json`

---

## Communication Principles

Pay attention to the user's technical level:

**Terms that are borderline** (explain if unsure):
- "YAML frontmatter", "assertion", "sub-agent", "iteration"

**Terms that are generally OK:**
- "test case", "evaluation", "benchmark", "feedback"

**When in doubt:** Briefly explain technical terms or include a short definition.

---

## The Core Loop (Repeated for Emphasis)

1. **Understand** what the skill should do
2. **Draft** the SKILL.md
3. **Test** with realistic prompts (with-skill vs baseline)
4. **Review** outputs with the user (qualitative + quantitative)
5. **Improve** based on feedback
6. **Iterate** until satisfied
7. **Gate** with `npm run build/test/check`
8. **Register** in `harness.toml`

Take your time. Think carefully. This is important work — these skills will be
used extensively. Write a draft, step back, and improve it before showing the
user.

Good luck! 🚀
