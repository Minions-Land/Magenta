use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("tool not found: {name}")]
    ToolNotFound { name: String },

    #[error("tool already registered: {name}")]
    ToolAlreadyRegistered { name: String },

    #[error("permission denied: {reason}")]
    PermissionDenied { reason: String },

    #[error("provider error: {0}")]
    Provider(#[from] ProviderCallError),

    #[error("agent run cancelled")]
    Cancelled,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

/// Lightweight provider-call error surfaced inside CoreError.
#[derive(Debug, Error)]
pub enum ProviderCallError {
    #[error("{model} failed")]
    Failed { model: String },

    #[error("{model} unavailable")]
    Unavailable { model: String },

    #[error("{model} stream failed")]
    StreamFailed { model: String },

    #[error("stream broke")]
    StreamBroke,

    #[error("all providers failed")]
    AllFailed,
}

impl From<String> for CoreError {
    fn from(s: String) -> Self {
        CoreError::Other(s)
    }
}

impl From<&str> for CoreError {
    fn from(s: &str) -> Self {
        CoreError::Other(s.to_owned())
    }
}
