//! Retry logic with exponential backoff and jitter.

use crate::error::{BioApiError, BioApiResult};
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, warn};

/// Retry policy configuration
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of retry attempts
    pub max_retries: u32,
    /// Initial backoff duration
    pub initial_backoff: Duration,
    /// Maximum backoff duration
    pub max_backoff: Duration,
    /// Multiplier for exponential backoff
    pub backoff_multiplier: f64,
    /// Whether to add jitter to backoff
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(30),
            backoff_multiplier: 2.0,
            jitter: true,
        }
    }
}

impl RetryPolicy {
    /// Create a new retry policy with custom settings
    pub fn new(max_retries: u32, initial_backoff: Duration) -> Self {
        Self {
            max_retries,
            initial_backoff,
            ..Default::default()
        }
    }

    /// Execute a function with retry logic
    pub async fn execute<F, Fut, T>(&self, operation: &str, mut f: F) -> BioApiResult<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = BioApiResult<T>>,
    {
        let mut attempt = 0;
        let mut backoff = self.initial_backoff;

        loop {
            match f().await {
                Ok(result) => {
                    if attempt > 0 {
                        debug!(
                            "Operation '{}' succeeded after {} retries",
                            operation, attempt
                        );
                    }
                    return Ok(result);
                }
                Err(err) => {
                    if !err.is_retryable() {
                        debug!("Operation '{}' failed with non-retryable error", operation);
                        return Err(err);
                    }

                    attempt += 1;
                    if attempt > self.max_retries {
                        warn!(
                            "Operation '{}' exceeded max retries ({})",
                            operation, self.max_retries
                        );
                        return Err(BioApiError::MaxRetriesExceeded {
                            operation: operation.to_string(),
                        });
                    }

                    let sleep_duration = if self.jitter {
                        self.add_jitter(backoff)
                    } else {
                        backoff
                    };

                    debug!(
                        "Operation '{}' failed (attempt {}/{}), retrying in {:?}: {}",
                        operation, attempt, self.max_retries, sleep_duration, err
                    );

                    sleep(sleep_duration).await;

                    // Exponential backoff
                    backoff = std::cmp::min(
                        Duration::from_secs_f64(backoff.as_secs_f64() * self.backoff_multiplier),
                        self.max_backoff,
                    );
                }
            }
        }
    }

    /// Add jitter to backoff duration (±25%)
    fn add_jitter(&self, duration: Duration) -> Duration {
        use rand::Rng;
        let jitter_factor = rand::thread_rng().gen_range(0.75..1.25);
        Duration::from_secs_f64(duration.as_secs_f64() * jitter_factor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn test_retry_success_first_attempt() {
        let policy = RetryPolicy::default();
        let call_count = Arc::new(AtomicU32::new(0));

        let result = policy
            .execute("test_op", || {
                let count = call_count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, BioApiError>(42)
                }
            })
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 42);
        assert_eq!(call_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_retry_success_after_failures() {
        let policy = RetryPolicy {
            max_retries: 3,
            initial_backoff: Duration::from_millis(10),
            jitter: false,
            ..Default::default()
        };
        let call_count = Arc::new(AtomicU32::new(0));

        let result = policy
            .execute("test_op", || {
                let count = call_count.clone();
                async move {
                    let current = count.fetch_add(1, Ordering::SeqCst) + 1;
                    if current < 3 {
                        Err(BioApiError::Timeout {
                            operation: "test".to_string(),
                        })
                    } else {
                        Ok::<_, BioApiError>(42)
                    }
                }
            })
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 42);
        assert_eq!(call_count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_retry_max_retries_exceeded() {
        let policy = RetryPolicy {
            max_retries: 2,
            initial_backoff: Duration::from_millis(10),
            jitter: false,
            ..Default::default()
        };
        let call_count = Arc::new(AtomicU32::new(0));

        let result = policy
            .execute("test_op", || {
                let count = call_count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Err::<i32, _>(BioApiError::Timeout {
                        operation: "test".to_string(),
                    })
                }
            })
            .await;

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BioApiError::MaxRetriesExceeded { .. }
        ));
        assert_eq!(call_count.load(Ordering::SeqCst), 3); // initial + 2 retries
    }

    #[tokio::test]
    async fn test_non_retryable_error() {
        let policy = RetryPolicy::default();
        let call_count = Arc::new(AtomicU32::new(0));

        let result = policy
            .execute("test_op", || {
                let count = call_count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Err::<i32, _>(BioApiError::InvalidInput("bad input".to_string()))
                }
            })
            .await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BioApiError::InvalidInput(_)));
        assert_eq!(call_count.load(Ordering::SeqCst), 1); // no retries for non-retryable errors
    }
}
