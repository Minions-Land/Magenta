# Loop Principles

The theoretical basis for research-orchestration's loop discipline. These are field notes on what makes long-running agent loops converge instead of spin. Read this when you want to understand *why* the loop is structured the way it is.

## The core shift: write the loop, not the prompt

A prompt is something you type once. A loop is a procedure that runs while you sleep. Once a model is good enough to follow a procedure without supervision, the unit of leverage stops being the prompt and becomes the procedure. If you find yourself endlessly tweaking one message, stop and write the loop instead. The loop is short: gather, reason, act, verify, repeat. Everything else is a footnote on those verbs.

## The eight principles

### 1. Separate the roles
A planner that turns a vague sentence into a spec and never touches the work. A generator that produces everything and is forbidden from grading itself. An evaluator that is told from the first message the work is broken and its job is to prove it. Mixing roles is the most common failure: a model becomes sycophantic the moment it grades itself, and the loop quietly converges on slop.

### 2. Negotiate the contract first
Before the generator produces anything, it proposes what "done" looks like and the evaluator pushes back. They argue via a file on disk until they agree on a checklist of testable assertions. Ten criteria is usually too few (the evaluator rubber-stamps); a few dozen is reasonable for a real task. The original objective is the boundary, but the contract is what gets graded. This single change moves runs from broken demos to working products.

### 3. Write to disk, not to context
Context windows lie: they compact, they rot, they hide what you said an hour ago behind a summary you did not write. A file does not lie. Keep the plan, the contract, the progress, and an append-only log. The loop should be able to crash, lose its session, and resume by reading a handful of files. If you cannot describe your state in a few files, your state is too complicated.

### 4. Let the loop restart
The best behavior from a strong model is the willingness to throw everything away and start over when a run goes sideways. Weaker models patch and patch until the codebase is archaeology; a strong model, given a clean evaluator and a contract on disk, will delete the project at iteration nine and ship a working version at iteration eleven. Do not interrupt this — the restart is the loop working correctly. Intervene only when the *contract* is wrong, not when the build is.

### 5. Score the subjective
Taste is gradable if you write it down. Pick a few axes, weight them, and score each 0–1 with a paragraph explaining the gap. Calibrate against known-good and known-bad references. The model will not invent taste; it converges toward the taste you described. The whole game is writing the rubric carefully enough that converging toward it is what you actually wanted.

### 6. Read the traces
Nearly every debugging insight about a loop comes from reading the raw transcript, not from running another experiment. Pipe the agent's output to a file, grep for the moment its judgment diverged from yours, fix the prompt for that exact moment, run again. This is the same muscle as reading a stack trace — except the trace is in English and most of it is the model talking to itself. Skip this and you are tuning by vibe.

### 7. The bottleneck always moves
When producing work stops being the bottleneck, planning becomes the bottleneck. When planning is solved, verification becomes the bottleneck. When verification is automated, taste becomes the bottleneck. You do not finish; you find the next thing to fix. The point of making the loop explicit is to make the next bottleneck visible. If everything looks smooth, you are not looking carefully enough.

### 8. Delete the scaffolding
The harness exists to compensate for the model. As the model improves, half of what you wrote last quarter becomes overhead. Re-read the loop structure against each capability change and delete anything the model now does for free. A structure that only ever grows is one you have stopped reading.

## How these map to the loop stages

- **PLAN** enforces #2 (contract first) and #3 (write plan/contract to disk).
- **IMPLEMENT** enforces #1 (generator role, no self-grading).
- **OBSERVE** enforces #6 (read the traces) and #3 (traces to disk).
- **REFLECT** enforces #1 (evaluator role) and #5 (score the subjective on axes).
- **REFINE** enforces #4 (restart beats rescue) and #7 (find the moved bottleneck).
- The whole cadence embodies "write the loop, not the prompt."
