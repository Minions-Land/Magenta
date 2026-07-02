# Hooks

Lifecycle hook provider migrated from Magenta1
`general-harness/kernel/src/hook_provider.rs`.

The provider returns declarative action/data envelopes. It does not directly
execute session, memory, approval, shell, or workflow targets; callers can route
the returned actions through HCP as needed.
