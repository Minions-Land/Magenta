Perform a small orchestration preflight in this repository.

1. Use a workflow sub-agent to inspect `HarnessComponentProtocol/eval/README.md` and return its purpose in one sentence.
2. Start one managed teammate to independently identify the eval scenario filenames, wait for its reply, and shut it down cleanly.
3. Return a compact JSON object with keys `workflow`, `teammate`, and `ok`. Set `ok` to true only if both delegated checks completed.

Inherit the configured model for every delegated call; do not set provider or model. Do not modify files. Do not leave delegated or background work running.
