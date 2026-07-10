---
name: self-evo-skill-creator
disable-model-invocation: true
---

# Sub-skill: Skill Creator

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill when the user wants to create a new skill, modify an
> existing skill, or optimize skill performance.

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

1. Decide what you want the skill to do and roughly how it should do it
2. Write a draft of the skill
3. Create a few test prompts and run magenta-with-access-to-the-skill on them
4. Help the user evaluate the results both qualitatively and quantitatively
   - While the runs happen in the background, draft some quantitative evals if there aren't any
   - Then explain them to the user
5. Use sub-agents to show the user the results for them to look at, and also show quantitative metrics
6. Rewrite the skill based on feedback from the user's evaluation of the results
7. Repeat until you're satisfied
8. Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

Then after the skill is done (but again, the order is flexible), you can also run skill description optimization to improve the triggering accuracy of the skill.

Cool? Cool.

---

## Communicating with the User

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. Pay attention to context cues to understand how to phrase your communication!

In the default case, just to give you some idea:
- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a Skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

**Key questions:**
1. What should this skill enable Magenta to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works?
   - Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases
   - Skills with subjective outputs (writing style, art) often don't need them
   - Suggest the appropriate default based on the skill type, but let the user decide

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

If useful for research (searching docs, finding similar skills, looking up best practices), research in parallel via sub-agents if available, otherwise inline. Come prepared with context to reduce burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

**YAML Frontmatter:**
```yaml
---
name: skill-identifier
description: >
  When to trigger, what it does. This is the primary triggering mechanism —
  include both what the skill does AND specific contexts for when to use it.
  All "when to use" info goes here, not in the body.
  
  Note: currently Magenta has a tendency to "undertrigger" skills — to not use
  them when they'd be useful. To combat this, make the skill descriptions a
  little bit "pushy". For instance, instead of "How to build a dashboard to
  display data", write "How to build a dashboard to display data. Make sure to
  use this skill whenever the user mentions dashboards, data visualization,
  metrics, or wants to display any kind of data, even if they don't explicitly
  ask for a 'dashboard.'"
---
```

#### Anatomy of a Skill

```
skill-name/
├── <source>/               (magenta/, pi/, codex/)
│   └── SKILL.md            (required)
│       ├── YAML frontmatter (name, description required)
│       └── Markdown instructions
└── assets/ (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── templates/  - Files used in output (templates, icons, fonts)
```

**Source discipline:** The `<source>` directory reflects origin:
- `magenta/` — created by Magenta for Magenta
- `pi/` — converted from Claude Code/Pi extension
- `codex/` — from GitHub Copilot

Never mislabel provenance with `magenta` just because Magenta did the integration.

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) — Always in context (~100 words)
2. **SKILL.md body** — In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** — As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can feel free to go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model should go next
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization:** When a skill supports multiple domains/frameworks, organize by variant:

```
cloud-deploy/
├── magenta/
│   └── SKILL.md (workflow + selection)
└── assets/
    └── references/
        ├── aws.md
        ├── gcp.md
        └── azure.md
```

Magenta reads only the relevant reference file.

#### Principle of Lack of Surprise

Skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats:**
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern:**
```markdown
## Commit message format

**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication

**Example 2:**
Input: Fixed bug in password reset
Output: fix(auth): resolve password reset token expiration
```

#### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

---

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to `evals/evals.json`. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

---

## Running and Evaluating Test Cases

**This section is one continuous sequence — don't stop partway through.**

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.) and within that, each test case gets a directory (`eval-0/`, `eval-1/`, etc.). Don't create all of this upfront — just create directories as you go.

### Step 1: Spawn All Runs (with-skill AND baseline) in the Same Turn

For each test case, spawn two sub-agents in the same turn — one with the skill, one without. This is important: don't spawn the with-skill runs first and then come back for baselines later. Launch everything at once so it all finishes around the same time.

**With-skill run:**
```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**Baseline run** (same prompt, but the baseline depends on context):
- **Creating a new skill:** no skill at all. Same prompt, no skill path, save to `without_skill/outputs/`
- **Improving an existing skill:** the old version. Before editing, snapshot the skill (`cp -r <skill-path> <workspace>/skill-snapshot/`), then point the baseline sub-agent at the snapshot. Save to `old_skill/outputs/`

Write an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: While Runs are in Progress, Draft Assertions

Don't just wait for the runs to finish — you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they'll see — both the qualitative outputs and the quantitative benchmark.

### Step 3: As Runs Complete, Capture Timing Data

When each sub-agent task completes, you receive a notification containing `total_tokens` and `duration_ms`. Save this data immediately to `timing.json` in the run directory:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

This is the only opportunity to capture this data — it comes through the task notification and isn't persisted elsewhere. Process each notification as it arrives rather than trying to batch them.

### Step 4: Present Results to User

Since Magenta doesn't have Claude's eval-viewer infrastructure yet, use a **manual review workflow**:

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

**Optional: Grade assertions** — If you wrote assertions, spawn a grader sub-agent that evaluates each assertion against the outputs. Save results to `grading.json`:

```json
{
  "expectations": [
    {
      "text": "Contains all required sections",
      "passed": true,
      "evidence": "Found: title, abstract, method, results, conclusion"
    }
  ]
}
```

For assertions that can be checked programmatically, write and run a script rather than eyeballing it.

---

## Improving the Skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to Think About Improvements

**Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs.

But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

**Keep the prompt lean.** Remove things that aren't pulling their weight. Make sure to read the transcripts, not just the final outputs — if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.

**Explain the why.** Try hard to explain the why behind everything you're asking the model to do. Today's LLMs are smart. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

**Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the sub-agents all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the sub-agent writing a `create_docx.py` or a `build_chart.py`, that's a strong signal the skill should bundle that script. Write it once, put it in `assets/scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The Iteration Loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs
   - If creating a new skill, the baseline is always `without_skill` (no skill)
   - If improving an existing skill, use your judgment on what makes sense as the baseline
3. Present results to the user for review
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Description Optimization (Advanced)

The `description` field in SKILL.md frontmatter is the primary mechanism that determines whether Magenta invokes a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy.

### Step 1: Generate Trigger Eval Queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. The queries must be realistic and something a Magenta user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail.

**Bad:** "Format this data", "Extract text from PDF", "Create a chart"

**Good:** "ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"

For the **should-trigger queries** (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger queries** (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Test and Iterate

For each query, test whether the skill triggers. Collect results and identify patterns:
- False negatives: should have triggered but didn't
- False positives: shouldn't have triggered but did

Propose an improved description based on these patterns. Iterate up to 5 times, using a held-out test set to avoid overfitting.

---

## Gate and Register

Before landing the skill, run Magenta's verification gates:

```bash
cd /Users/mjm/Magenta3/HarnessComponentProtocol

# Build and verify
npm run generate:hcp-sources -- --check
npm run check:structure      # Enforces module layout rules
npm run build                # Must be green
npm test                     # No regressions
npm run inspect              # Confirm skill resolves correctly
```

### Register in harness.toml

Add the skill to `HarnessComponentProtocol/harness.toml`:

```toml
[[components]]
kind = "skill"
name = "skill-name"
source = "magenta"  # or "pi", "codex", etc.
path = "skills/skill-name/skill-name.toml"
```

### Verify Registration

```bash
npm run inspect | grep -A 5 "skill-name"
```

Confirm the skill appears in the registry and has no warnings.

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

Never mislabel provenance with `magenta` just because Magenta did the integration.

### One-of Invariant

A skill should focus on **one domain or workflow**. If you find yourself creating multiple distinct sub-workflows, consider:
- Splitting into separate skills
- Using a skill that routes to reference docs for each variant

### Preserve Existing Names

When improving an existing skill:
- Keep the original directory name and frontmatter `name`
- Don't append `-v2` or version numbers
- Edit in place (or copy to writable location if needed)

---

## Summary: The Core Loop

1. **Understand** what the skill should do
2. **Draft** the SKILL.md
3. **Test** with realistic prompts (with-skill vs baseline, parallel sub-agents)
4. **Review** outputs with the user (qualitative + quantitative)
5. **Improve** based on feedback
6. **Iterate** until satisfied
7. **Optimize** description (optional)
8. **Gate** with `npm run build/test/check`
9. **Register** in `harness.toml`

Take your time. Think carefully. This is important work — these skills will be used extensively. Write a draft, step back, and improve it before showing the user.

Good luck! 🚀
