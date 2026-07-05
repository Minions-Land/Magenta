//! aose-mcp (trimmed): MCP stdio **server** only.
//!
//! The original crate also carried an MCP *client* (reqwest/SSE) that depended
//! on aose-core modules dropped in this vendored copy. Only the server is kept.
//!
//! Origin: github.com/Minions-Land/AutOmicScience, crate `aose-mcp`.

pub mod server;
