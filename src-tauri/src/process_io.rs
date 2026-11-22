use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Ready,
    Pending,
    #[default]
    Unavailable,
    Error,
}

#[derive(Clone, Copy)]
pub(crate) struct Failure {
    pub(crate) status: Status,
    pub(crate) code: u32,
}

impl Failure {
    pub(crate) fn windows(code: u32) -> Self {
        // Access denied, expired PID/handle and unsupported counters are unavailable.
        let status = match code {
            5 | 6 | 50 | 87 | 1168 => Status::Unavailable,
            _ => Status::Error,
        };
        Self { status, code }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Observation {
    pub(crate) started: u64,
    pub(crate) creation_ticks: u64,
    pub(crate) read_bytes: u64,
    pub(crate) written_bytes: u64,
}

#[derive(Default)]
pub(crate) struct Rates {
    pub(crate) status: Status,
    pub(crate) code: Option<u32>,
    pub(crate) read: f64,
    pub(crate) written: f64,
}

#[derive(Default)]
pub(crate) struct History {
    samples: HashMap<u32, (Observation, Instant)>,
}

impl History {
    pub(crate) fn retain(&mut self, mut is_current: impl FnMut(u32, u64) -> bool) {
        self.samples
            .retain(|&pid, (value, _)| is_current(pid, value.started));
    }

    pub(crate) fn measure(
        &mut self,
        pid: u32,
        started: u64,
        current: Option<Result<Observation, Failure>>,
        now: Instant,
    ) -> Rates {
        let pending = || Rates {
            status: Status::Pending,
            ..Default::default()
        };
        let observation = match current {
            Some(Ok(value)) if value.started > 0 && value.started == started => value,
            Some(Ok(_)) => return pending(),
            Some(Err(error)) => {
                return Rates {
                    status: error.status,
                    code: Some(error.code),
                    ..Default::default()
                };
            }
            None => return Rates::default(),
        };
        let (read, written, seconds) = match self.samples.get(&pid) {
            Some((previous, at)) if observation.creation_ticks == previous.creation_ticks => {
                let Some(elapsed) = now
                    .checked_duration_since(*at)
                    .filter(|elapsed| !elapsed.is_zero())
                else {
                    return pending();
                };
                let bytes = observation.read_bytes.checked_sub(previous.read_bytes).zip(
                    observation
                        .written_bytes
                        .checked_sub(previous.written_bytes),
                );
                let Some((read, written)) = bytes else {
                    self.samples.insert(pid, (observation, now));
                    return pending();
                };
                (read, written, elapsed.as_secs_f64())
            }
            _ => {
                self.samples.insert(pid, (observation, now));
                return pending();
            }
        };
        self.samples.insert(pid, (observation, now));
        Rates {
            status: Status::Ready,
            code: None,
            read: read as f64 / seconds,
            written: written as f64 / seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn counter(ticks: u64, read: u64, written: u64) -> Option<Result<Observation, Failure>> {
        Some(Ok(Observation {
            started: 10,
            creation_ticks: ticks,
            read_bytes: read,
            written_bytes: written,
        }))
    }

    #[test]
    fn baseline_denial_recovery_idle_and_poll_interval() {
        let mut h = History::default();
        let t = Instant::now();
        assert_eq!(
            h.measure(20, 10, counter(1, 1000, 2000), t).status,
            Status::Pending
        );
        let denied = h.measure(
            20,
            10,
            Some(Err(Failure::windows(5))),
            t + Duration::from_secs(1),
        );
        assert_eq!((denied.status, denied.code), (Status::Unavailable, Some(5)));
        let rates = h.measure(20, 10, counter(1, 1001, 2400), t + Duration::from_secs(2));
        assert_eq!(
            (rates.status, rates.read, rates.written),
            (Status::Ready, 0.5, 200.0)
        );
        let idle = h.measure(20, 10, counter(1, 1001, 2400), t + Duration::from_secs(7));
        assert_eq!(
            (idle.status, idle.read, idle.written),
            (Status::Ready, 0.0, 0.0)
        );
        assert_eq!(
            h.measure(20, 10, Some(Err(Failure::windows(31))), t).status,
            Status::Error
        );
    }

    #[test]
    fn reused_pid_within_same_second_and_counter_reset_need_new_baseline() {
        let mut h = History::default();
        let t = Instant::now();
        h.measure(20, 10, counter(1, 1000, 1000), t);
        assert_eq!(
            h.measure(20, 10, counter(2, 4000, 4000), t + Duration::from_secs(1))
                .status,
            Status::Pending
        );
        assert_eq!(
            h.measure(20, 10, counter(2, 1000, 4000), t + Duration::from_secs(2))
                .status,
            Status::Pending
        );
        h.retain(|_, _| false);
        assert!(h.samples.is_empty());
    }
}
