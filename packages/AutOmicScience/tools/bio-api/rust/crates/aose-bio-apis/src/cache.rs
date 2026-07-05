//! Response caching for bioinformatics API clients.
//!
//! This module provides an in-memory cache backed by moka.

use moka::future::Cache;
use std::time::Duration;

/// Response cache for API results
pub struct ApiCache<K, V>
where
    K: std::hash::Hash + Eq + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    cache: Cache<K, V>,
}

impl<K, V> ApiCache<K, V>
where
    K: std::hash::Hash + Eq + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    /// Create a new cache with the specified capacity and TTL
    pub fn new(max_capacity: u64, ttl: Duration) -> Self {
        let cache = Cache::builder()
            .max_capacity(max_capacity)
            .time_to_live(ttl)
            .build();

        Self { cache }
    }

    /// Get a value from the cache
    pub async fn get(&self, key: &K) -> Option<V> {
        self.cache.get(key).await
    }

    /// Insert a value into the cache
    pub async fn insert(&self, key: K, value: V) {
        self.cache.insert(key, value).await;
    }

    /// Remove a value from the cache
    pub async fn invalidate(&self, key: &K) {
        self.cache.invalidate(key).await;
    }

    /// Clear the entire cache
    pub async fn clear(&self) {
        self.cache.invalidate_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_basic_operations() {
        let cache: ApiCache<String, String> = ApiCache::new(100, Duration::from_secs(60));

        // Insert and retrieve
        cache.insert("key1".to_string(), "value1".to_string()).await;
        let value = cache.get(&"key1".to_string()).await;
        assert_eq!(value, Some("value1".to_string()));

        // Missing key
        let missing = cache.get(&"missing".to_string()).await;
        assert_eq!(missing, None);

        // Invalidate
        cache.invalidate(&"key1".to_string()).await;
        let after_invalidate = cache.get(&"key1".to_string()).await;
        assert_eq!(after_invalidate, None);
    }
}
