# Plan

1. Add an explicit SessionManager flush boundary for pre-seeded clean sessions.
2. Expose SendMessageController's existing delivery path for controller reuse.
3. Implement TeammateAgentController with persistent RPC child management and `/events` registration.
4. Wire the controller into AgentSession lifecycle and native tool activation.
5. Add unit and integration regression tests.
6. Run focused tests, package build/typecheck, then broader relevant tests.
