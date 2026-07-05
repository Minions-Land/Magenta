//! Batch and parallel query execution utilities.

use futures::future::join_all;
use std::future::Future;
use tokio::task::JoinHandle;

/// Execute multiple async operations in parallel with concurrency limit.
///
/// # Arguments
/// * `tasks` - Iterator of async operations
/// * `concurrency` - Maximum number of concurrent operations (None = unlimited)
///
/// # Returns
/// Vector of results in the same order as input tasks
pub async fn parallel_execute<T, F, Fut>(
    tasks: impl IntoIterator<Item = F>,
    concurrency: Option<usize>,
) -> Vec<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let futures: Vec<_> = tasks.into_iter().map(|task| tokio::spawn(task())).collect();

    if let Some(limit) = concurrency {
        parallel_execute_limited(futures, limit).await
    } else {
        parallel_execute_unlimited(futures).await
    }
}

/// Execute with concurrency limit using semaphore
async fn parallel_execute_limited<T>(handles: Vec<JoinHandle<T>>, concurrency: usize) -> Vec<T> {
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    let semaphore = Arc::new(Semaphore::new(concurrency));
    let mut results = Vec::with_capacity(handles.len());

    for handle in handles {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let result = handle.await.expect("Task panicked");
        drop(permit);
        results.push(result);
    }

    results
}

/// Execute without concurrency limit
async fn parallel_execute_unlimited<T>(handles: Vec<JoinHandle<T>>) -> Vec<T> {
    join_all(handles)
        .await
        .into_iter()
        .map(|r| r.expect("Task panicked"))
        .collect()
}

/// Batch executor for API queries with rate limiting awareness.
pub struct BatchExecutor {
    concurrency: usize,
}

impl BatchExecutor {
    /// Create a new batch executor with specified concurrency.
    pub fn new(concurrency: usize) -> Self {
        Self { concurrency }
    }

    /// Execute batch of queries in parallel.
    ///
    /// # Example
    /// ```ignore
    /// let executor = BatchExecutor::new(10);
    /// let genes = vec!["BRCA1", "TP53", "EGFR"];
    /// let results = executor.execute_batch(genes, |gene| async move {
    ///     client.get_gene(gene).await
    /// }).await;
    /// ```
    pub async fn execute_batch<T, F, Fut, I>(&self, items: I, operation: F) -> Vec<T>
    where
        I: IntoIterator,
        I::Item: Send + 'static,
        F: Fn(I::Item) -> Fut + Send + Sync + Clone + 'static,
        Fut: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        use std::sync::Arc;

        let op = Arc::new(operation);
        let tasks: Vec<_> = items
            .into_iter()
            .map(|item| {
                let op_clone = Arc::clone(&op);
                move || {
                    let op = op_clone;
                    async move { op(item).await }
                }
            })
            .collect();

        parallel_execute(tasks, Some(self.concurrency)).await
    }
}

/// Helper to chunk large queries into smaller batches
pub fn chunk_queries<T: Clone>(items: Vec<T>, chunk_size: usize) -> Vec<Vec<T>> {
    items
        .chunks(chunk_size)
        .map(|chunk| chunk.to_vec())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::{sleep, Instant};

    #[tokio::test]
    async fn test_parallel_execute_unlimited() {
        let tasks = (0..5).map(|i| {
            move || async move {
                sleep(Duration::from_millis(10)).await;
                i * 2
            }
        });

        let start = Instant::now();
        let results = parallel_execute(tasks, None).await;
        let elapsed = start.elapsed();

        assert_eq!(results, vec![0, 2, 4, 6, 8]);
        // Should complete in ~10ms, not 50ms
        assert!(elapsed < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn test_parallel_execute_limited() {
        let tasks = (0..10).map(|i| {
            move || async move {
                sleep(Duration::from_millis(10)).await;
                i
            }
        });

        let start = Instant::now();
        let results = parallel_execute(tasks, Some(3)).await;
        let elapsed = start.elapsed();

        assert_eq!(results.len(), 10);
        // With concurrency=3, should take ~40ms (10 tasks / 3 concurrent * 10ms)
        assert!(elapsed < Duration::from_millis(100));
    }

    #[tokio::test]
    async fn test_batch_executor() {
        let executor = BatchExecutor::new(5);
        let numbers = vec![1, 2, 3, 4, 5];

        let results = executor
            .execute_batch(numbers, move |n| async move { n * n })
            .await;

        assert_eq!(results, vec![1, 4, 9, 16, 25]);
    }

    #[test]
    fn test_chunk_queries() {
        let items = vec![1, 2, 3, 4, 5, 6, 7];
        let chunks = chunk_queries(items, 3);

        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0], vec![1, 2, 3]);
        assert_eq!(chunks[1], vec![4, 5, 6]);
        assert_eq!(chunks[2], vec![7]);
    }
}
