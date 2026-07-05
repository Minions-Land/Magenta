//! Unified error types for bioinformatics API clients.

use thiserror::Error;

pub type BioApiResult<T> = Result<T, BioApiError>;

#[derive(Error, Debug)]
pub enum BioApiError {
    #[error("HTTP request failed: {0}")]
    RequestFailed(#[from] reqwest::Error),

    #[error("API returned error status {status}: {message}")]
    ApiError { status: u16, message: String },

    #[error("Rate limit exceeded. Retry after {retry_after_secs} seconds")]
    RateLimitExceeded { retry_after_secs: u64 },

    #[error("JSON deserialization failed: {0}")]
    DeserializationError(#[from] serde_json::Error),

    #[error("CSV parsing failed: {0}")]
    CsvError(#[from] csv::Error),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Timeout waiting for {operation}")]
    Timeout { operation: String },

    #[error("Maximum retries exceeded for {operation}")]
    MaxRetriesExceeded { operation: String },

    #[error("Invalid response format: {0}")]
    InvalidResponse(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Other error: {0}")]
    Other(String),
}

impl BioApiError {
    /// Check if this error is retryable
    pub fn is_retryable(&self) -> bool {
        match self {
            BioApiError::RequestFailed(_) | BioApiError::Timeout { .. } => true,
            BioApiError::ApiError { status, .. } => *status >= 500,
            _ => false,
        }
    }

    /// Check if this is a rate limit error
    pub fn is_rate_limit(&self) -> bool {
        matches!(self, BioApiError::RateLimitExceeded { .. })
    }

    /// Attach failure context to this error for diagnostic purposes
    ///
    /// This method doesn't modify the error itself but can be used
    /// by healing infrastructure to associate context with an error.
    #[cfg(feature = "healing")]
    pub fn with_context(
        self,
        client_id: String,
        endpoint: String,
        attempt_count: u32,
    ) -> (Self, crate::healing::FailureContext) {
        let context = crate::healing::FailureContext::new(client_id, endpoint, attempt_count);
        (self, context)
    }
}
