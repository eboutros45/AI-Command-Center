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
struct ActivityStage {
    label: String,
    actor: Option<String>,
    provider: Option<Provider>,
    model: Option<String>,
    status: WorkStatus,
    started_at: u64,
    finished_at: Option<u64>,
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
    stages: Vec<ActivityStage>,
}

impl Work {
    fn advance(
        &mut self,
        stage: &str,
        actor: Option<&str>,
        model: Option<(Provider, &str)>,
        now: u64,
    ) {
        self.close_stage(WorkStatus::Completed, now);
        self.stage = stage.into();
        self.actor = actor.map(str::to_owned);
        self.provider = model.map(|(provider, _)| provider);
        self.model = model.map(|(_, name)| name.to_owned());
        self.stages.push(ActivityStage {
            label: self.stage.clone(),
            actor: self.actor.clone(),
            provider: self.provider,
            model: self.model.clone(),
            status: WorkStatus::Running,
            started_at: now,
            finished_at: None,
        });
    }

    fn close_stage(&mut self, status: WorkStatus, now: u64) {
        if let Some(stage) = self
            .stages
            .last_mut()
            .filter(|stage| stage.status == WorkStatus::Running)
        {
            stage.status = status;
            stage.finished_at = Some(now.max(stage.started_at));
        }
    }
}

fn timestamp() -> Option<u64> {
    UNIX_EPOCH
        .elapsed()
        .ok()
        .map(|time| time.as_millis() as u64)
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
                    stages: Vec::new(),
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
                work.advance(stage, actor, model, timestamp().unwrap_or(work.started_at));
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
                let now = timestamp().unwrap_or(work.started_at);
                work.finished_at = Some(now.max(work.started_at));
                work.close_stage(work.status, now);
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
                stages: Vec::new(),
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

    #[test]
    fn timeline_closes_previous_stage_and_preserves_each_model() {
        let mut work = Work {
            id: "test".into(),
            title: "Proposal".into(),
            kind: WorkKind::Proposal,
            status: WorkStatus::Running,
            stage: "Starting".into(),
            actor: None,
            provider: None,
            model: None,
            started_at: 100,
            finished_at: None,
            stages: Vec::new(),
        };
        work.advance(
            "Draft",
            Some("Writer"),
            Some((Provider::Ollama, "local-model")),
            120,
        );
        work.advance(
            "Review",
            Some("Editor"),
            Some((Provider::OpenAi, "hosted-model")),
            160,
        );
        work.close_stage(WorkStatus::Stopped, 180);
        assert!(work.stages[0].status == WorkStatus::Completed);
        assert_eq!(work.stages[0].finished_at, Some(160));
        assert_eq!(work.stages[0].model.as_deref(), Some("local-model"));
        assert!(work.stages[1].status == WorkStatus::Stopped);
        assert_eq!(work.stages[1].finished_at, Some(180));
        assert_eq!(work.stages[1].actor.as_deref(), Some("Editor"));
    }
}
