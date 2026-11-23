use crate::skill_runs::Provider;
use serde::Serialize;
use std::{sync::Mutex, time::UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT: &str = "agent-activity";
const RECENT_LIMIT: usize = 30;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkKind {
    AgentTest,
    Proposal,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkStatus {
    Running,
    Completed,
    Stopped,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Work {
    id: String,
    title: String,
    kind: WorkKind,
    status: WorkStatus,
    stage: String,
    actor: Option<String>,
    provider: Option<Provider>,
    model: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct ActivitySnapshot {
    revision: u64,
    work: Vec<Work>,
}

impl ActivitySnapshot {
    fn trim_recent(&mut self) {
        let mut recent = 0;
        self.work.retain(|work| {
            if work.status == WorkStatus::Running {
                return true;
            }
            recent += 1;
            recent <= RECENT_LIMIT
        });
    }
}

#[derive(Default)]
pub(crate) struct ActivityLedger(Mutex<ActivitySnapshot>);

#[tauri::command]
pub(crate) fn activity_snapshot(
    ledger: State<'_, ActivityLedger>,
) -> Result<ActivitySnapshot, String> {
    ledger
        .inner()
        .0
        .lock()
        .map(|state| state.clone())
        .map_err(|_| "Agent activity is unavailable.".into())
}

pub(crate) struct Tracker {
    app: AppHandle,
    id: String,
    finished: bool,
}

impl Tracker {
    pub(crate) fn start(
        app: &AppHandle,
        id: &str,
        started_at: u64,
        title: String,
        kind: WorkKind,
    ) -> Self {
        let tracker = Self {
            app: app.clone(),
            id: id.into(),
            finished: false,
        };
        tracker.publish(|snapshot| {
            snapshot.work.insert(
                0,
                Work {
                    id: id.into(),
                    title,
                    kind,
                    status: WorkStatus::Running,
                    stage: "Starting".into(),
                    actor: None,
                    provider: None,
                    model: None,
                    started_at,
                    finished_at: None,
                },
            )
        });
        tracker
    }

    pub(crate) fn step(&self, stage: &str, actor: Option<&str>, model: Option<(Provider, &str)>) {
        self.publish(|snapshot| {
            if let Some(work) = snapshot
                .work
                .iter_mut()
                .find(|work| work.id == self.id && work.status == WorkStatus::Running)
            {
                work.stage = stage.into();
                work.actor = actor.map(str::to_owned);
                work.provider = model.map(|(provider, _)| provider);
                work.model = model.map(|(_, name)| name.to_owned());
            }
        });
    }

    pub(crate) fn finish(&mut self, successful: bool, stage: &str) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.publish(|snapshot| {
            if let Some(index) = snapshot.work.iter().position(|work| work.id == self.id) {
                let mut work = snapshot.work.remove(index);
                work.status = if successful {
                    WorkStatus::Completed
                } else {
                    WorkStatus::Stopped
                };
                work.stage = stage.into();
                work.finished_at = UNIX_EPOCH
                    .elapsed()
                    .ok()
                    .map(|time| time.as_millis() as u64);
                snapshot.work.insert(0, work);
                snapshot.trim_recent();
            }
        });
    }

    fn publish(&self, update: impl FnOnce(&mut ActivitySnapshot)) {
        let ledger = self.app.state::<ActivityLedger>();
        let snapshot = {
            let Ok(mut state) = ledger.inner().0.lock() else {
                return;
            };
            update(&mut state);
            state.revision += 1;
            state.clone()
        };
        let _ = self.app.emit(EVENT, snapshot);
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.finish(false, "Run ended before completion");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_limit_keeps_older_active_work_visible() {
        let work = (0..RECENT_LIMIT + 2)
            .map(|index| Work {
                id: index.to_string(),
                title: "Test".into(),
                kind: WorkKind::AgentTest,
                status: if index == RECENT_LIMIT + 1 {
                    WorkStatus::Running
                } else {
                    WorkStatus::Completed
                },
                stage: String::new(),
                actor: None,
                provider: None,
                model: None,
                started_at: 0,
                finished_at: None,
            })
            .collect();
        let mut snapshot = ActivitySnapshot { revision: 0, work };
        snapshot.trim_recent();
        assert_eq!(snapshot.work.len(), RECENT_LIMIT + 1);
        assert!(
            snapshot
                .work
                .last()
                .is_some_and(|item| item.status == WorkStatus::Running)
        );
        assert!(
            !snapshot
                .work
                .iter()
                .any(|item| item.id == RECENT_LIMIT.to_string())
        );
    }
}
