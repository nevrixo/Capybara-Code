//! Resource limits — PRD §14.7.
//!
//! | Resource                     | Default        |
//! |------------------------------|---------------:|
//! | single process timeout       | 10 min         |
//! | interactive PTY idle timeout | 30 min         |
//! | captured output              | 10 MB before spill |
//! | in-memory output buffer      | 1 MB           |
//! | concurrent processes         | 4              |
//! | open files                   | platform-safe bounded |
//! | CPU/memory                   | warning and platform enforcement |

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    pub process_timeout_ms: u64,
    pub pty_idle_timeout_ms: u64,
    pub captured_output_bytes: usize,
    pub inline_buffer_bytes: usize,
    pub max_concurrent_processes: usize,
    pub max_open_files: u64,
    pub max_memory_bytes: Option<u64>,
    pub max_cpu_seconds: Option<u64>,
}

pub const DEFAULT_LIMITS: ResourceLimits = ResourceLimits {
    process_timeout_ms: 10 * 60 * 1000,
    pty_idle_timeout_ms: 30 * 60 * 1000,
    captured_output_bytes: 10 * 1024 * 1024,
    inline_buffer_bytes: 1024 * 1024,
    max_concurrent_processes: 4,
    max_open_files: 1024,
    max_memory_bytes: None,
    max_cpu_seconds: None,
};

impl Default for ResourceLimits {
    fn default() -> Self {
        DEFAULT_LIMITS
    }
}

impl ResourceLimits {
    /// Tighter limits for subagent-owned processes (§11.3 halves most root
    /// budgets for children).
    pub fn for_subagent() -> Self {
        Self {
            process_timeout_ms: 5 * 60 * 1000,
            max_concurrent_processes: 2,
            ..DEFAULT_LIMITS
        }
    }

    /// Clamp a caller-supplied timeout so a model cannot request an unbounded
    /// process (§12.4 "timeout mandatory default").
    pub fn clamp_timeout(&self, requested_ms: u64) -> u64 {
        if requested_ms == 0 {
            return self.process_timeout_ms;
        }
        requested_ms.min(self.process_timeout_ms)
    }

    pub fn clamp_output(&self, requested: usize) -> usize {
        if requested == 0 {
            return self.captured_output_bytes;
        }
        requested.min(self.captured_output_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_prd_table() {
        assert_eq!(DEFAULT_LIMITS.process_timeout_ms, 600_000);
        assert_eq!(DEFAULT_LIMITS.pty_idle_timeout_ms, 1_800_000);
        assert_eq!(DEFAULT_LIMITS.captured_output_bytes, 10 * 1024 * 1024);
        assert_eq!(DEFAULT_LIMITS.inline_buffer_bytes, 1024 * 1024);
        assert_eq!(DEFAULT_LIMITS.max_concurrent_processes, 4);
    }

    #[test]
    fn subagent_limits_are_tighter() {
        let sub = ResourceLimits::for_subagent();
        assert!(sub.process_timeout_ms < DEFAULT_LIMITS.process_timeout_ms);
        assert!(sub.max_concurrent_processes < DEFAULT_LIMITS.max_concurrent_processes);
    }

    #[test]
    fn clamps_requested_timeout_to_ceiling() {
        let limits = DEFAULT_LIMITS;
        assert_eq!(limits.clamp_timeout(1_000), 1_000);
        assert_eq!(limits.clamp_timeout(0), limits.process_timeout_ms);
        assert_eq!(
            limits.clamp_timeout(u64::MAX),
            limits.process_timeout_ms,
            "a model must not be able to request an unbounded process"
        );
    }

    #[test]
    fn clamps_requested_output_to_ceiling() {
        let limits = DEFAULT_LIMITS;
        assert_eq!(limits.clamp_output(1024), 1024);
        assert_eq!(limits.clamp_output(0), limits.captured_output_bytes);
        assert_eq!(
            limits.clamp_output(usize::MAX),
            limits.captured_output_bytes
        );
    }
}
