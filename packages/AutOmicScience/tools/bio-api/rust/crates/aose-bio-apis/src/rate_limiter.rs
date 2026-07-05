//! Rate limiting using token bucket algorithm.

use governor::{
    clock::DefaultClock,
    state::{InMemoryState, NotKeyed},
    Quota, RateLimiter as GovernorRateLimiter,
};
use std::num::NonZeroU32;
use std::time::Duration;

/// Rate limiter for API requests
pub struct RateLimiter {
    limiter: GovernorRateLimiter<NotKeyed, InMemoryState, DefaultClock>,
    rate: u32,
}

impl RateLimiter {
    /// Create a new rate limiter with requests per second
    pub fn new(requests_per_second: u32) -> Self {
        let quota = Quota::per_second(NonZeroU32::new(requests_per_second).unwrap());
        Self {
            limiter: GovernorRateLimiter::direct(quota),
            rate: requests_per_second,
        }
    }

    /// Get the configured rate (requests per second)
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Create a rate limiter with custom quota (e.g., 100 requests per minute)
    pub fn with_quota(max_requests: u32, per_duration: Duration) -> Self {
        let quota = Quota::with_period(Duration::from_nanos(
            per_duration.as_nanos() as u64 / max_requests as u64,
        ))
        .unwrap()
        .allow_burst(NonZeroU32::new(max_requests).unwrap());

        Self {
            limiter: GovernorRateLimiter::direct(quota),
            rate: max_requests,
        }
    }

    /// Wait until a request can be made (blocking)
    pub async fn acquire(&self) {
        self.limiter.until_ready().await;
    }

    /// Try to acquire a permit without waiting
    pub fn try_acquire(&self) -> bool {
        self.limiter.check().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[tokio::test]
    async fn test_rate_limiter_basic() {
        let limiter = RateLimiter::new(10); // 10 requests per second

        // First request should be immediate
        let start = Instant::now();
        limiter.acquire().await;
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_millis(10));
    }

    #[tokio::test]
    async fn test_rate_limiter_burst() {
        let limiter = RateLimiter::new(5); // 5 requests per second

        // First 5 requests should be fast
        let start = Instant::now();
        for _ in 0..5 {
            limiter.acquire().await;
        }
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_millis(100));
    }

    #[tokio::test]
    async fn test_try_acquire() {
        let limiter = RateLimiter::new(1); // 1 request per second

        // First try should succeed
        assert!(limiter.try_acquire());

        // Immediate second try should fail
        assert!(!limiter.try_acquire());
    }
}
