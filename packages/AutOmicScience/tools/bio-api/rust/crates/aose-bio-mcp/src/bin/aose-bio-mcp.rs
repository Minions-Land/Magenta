//! Bio-API MCP server.
//!
//! Exposes every bio-database tool from `aose_bio_mcp::bio_typed` as an MCP
//! server over stdio. Designed to be spawned by the Magenta3 harness (via the
//! `runtime = "mcp"` cable in a package descriptor) or by any other MCP client.
//!
//! Usage:
//!   aose-bio-mcp
//!
//! The server speaks JSON-RPC 2.0 over stdin/stdout and blocks until the client
//! closes the connection. API keys for gated clients (DrugBank, DisGeNET, etc.)
//! are read from environment variables at startup; missing keys simply omit
//! those tools from the tool list.

use anyhow::Result;
use aose_core::ToolSet;
use std::sync::Arc;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    // Initialise the tool set from all bio-typed tools. Key-gated clients
    // (DrugBank, DisGeNET, BioGRID, OMIM) are included only when the relevant
    // env var is present — this is handled inside all_bio_typed_tools().
    let mut tool_set = ToolSet::new();
    aose_bio_mcp::bio_typed::register_all_bio_typed_tools(&mut tool_set)?;

    // Serve over stdio until the client disconnects.
    aose_mcp::server::serve_stdio(Arc::new(tool_set), "aose-bio-mcp").await?;

    Ok(())
}
