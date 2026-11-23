use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};
use tauri::Manager;

const RECENT_RUNS: usize = 30;
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillRun {
    id: String,
    timestamp: u64,
    skill_name: String,
    skill_path: String,
    fingerprint: String,
    skill_source: String,
    model: String,
    input: String,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResult {
    run: SkillRun,
    save_error: Option<String>,
}

fn history_directory(app_data: &Path, library: &str) -> Result<PathBuf, String> {
    let root = super::canonical_dir(Path::new(library))?;
    Ok(app_data
        .join("skill-runs")
        .join(super::fingerprint(&root.to_string_lossy())))
}

fn save_run(directory: &Path, run: &SkillRun) -> Result<(), String> {
    let bytes = serde_json::to_vec(run).map_err(super::err)?;
    fs::create_dir_all(directory).map_err(super::err)?;
    let temporary = directory.join(format!("{}.tmp", run.id));
    let result = {
        let mut file = fs::File::create_new(&temporary).map_err(super::err)?;
        file.write_all(&bytes).and_then(|()| file.sync_all())
    };
    let result =
        result.and_then(|()| fs::rename(&temporary, directory.join(format!("{}.json", run.id))));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(super::err)
}

fn recent_runs(directory: &Path) -> Result<Vec<SkillRun>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(super::err(error)),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(super::err)?;
        let path = entry.path();
        if entry.file_type().map_err(super::err)?.is_file()
            && path.extension().is_some_and(|ext| ext == "json")
        {
            files.push(path);
        }
    }
    files.sort_unstable_by(|a, b| b.cmp(a));
    files
        .into_iter()
        .take(RECENT_RUNS)
        .map(|path| {
            let file = fs::File::open(path).map_err(super::err)?;
            serde_json::from_reader(file).map_err(super::err)
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn list_skill_runs(
    app: tauri::AppHandle,
    library_root: String,
) -> Result<Vec<SkillRun>, String> {
    let app_data = app.path().app_data_dir().map_err(super::err)?;
    tauri::async_runtime::spawn_blocking(move || {
        recent_runs(&history_directory(&app_data, &library_root)?)
    })
    .await
    .map_err(super::err)?
}

#[tauri::command]
pub(crate) async fn run_skill_test(
    app: tauri::AppHandle,
    library_root: String,
    skill_path: String,
    model: String,
    input: String,
) -> Result<RunResult, String> {
    let input = input.trim().to_owned();
    if input.is_empty() || input.chars().count() > 4_000 {
        return Err("Enter an example input of up to 4,000 characters.".into());
    }
    let app_data = app.path().app_data_dir().map_err(super::err)?;
    let (directory, skill) = tauri::async_runtime::spawn_blocking(move || {
        let directory = history_directory(&app_data, &library_root)?;
        let skill = super::read_skill(library_root, skill_path)?;
        Ok::<_, String>((directory, skill))
    })
    .await
    .map_err(super::err)??;
    if skill.status != "valid" || skill.content.chars().count() > 8_000 {
        return Err("Choose a valid saved skill with source under 8,000 characters.".into());
    }
    let model = model.trim().to_owned();
    let system = format!(
        "Respond to the example input using the saved skill below. Use the skill as guidance for this text response. If it calls for tools or external actions, explain what additional information or access you would need.\n\n{}",
        skill.content
    );
    let output = super::ollama::generate(&model, &system, &input).await?;
    let timestamp = UNIX_EPOCH.elapsed().map_err(super::err)?.as_millis() as u64;
    let sequence = RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let run = SkillRun {
        id: format!("{timestamp:020}-{:010}-{sequence:020}", std::process::id()),
        timestamp,
        skill_name: skill.name,
        skill_path: skill.path,
        fingerprint: skill.fingerprint,
        skill_source: skill.content,
        model,
        input,
        output,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let save_error = save_run(&directory, &run).err();
        RunResult { run, save_error }
    })
    .await
    .map_err(super::err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_exact_skill_and_input_snapshots() {
        let directory = std::env::temp_dir().join(format!(
            "command-center-history-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let exercise = || -> Result<Vec<SkillRun>, String> {
            let mut run = SkillRun {
                id: "001".into(),
                timestamp: 1,
                skill_name: "Reviewer".into(),
                skill_path: "reviewer".into(),
                fingerprint: "first-fingerprint".into(),
                skill_source: "First instructions".into(),
                model: "gemma3:4b".into(),
                input: "First draft".into(),
                output: "First review".into(),
            };
            save_run(&directory, &run)?;
            run.id = "002".into();
            run.timestamp = 2;
            run.fingerprint = "second-fingerprint".into();
            run.skill_source = "Updated instructions".into();
            save_run(&directory, &run)?;
            fs::write(directory.join("incomplete.tmp"), "{").map_err(super::super::err)?;
            recent_runs(&directory)
        };
        let history = exercise();
        fs::remove_dir_all(directory).unwrap();
        let history = history.unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].skill_source, "Updated instructions");
        assert_eq!(history[1].skill_source, "First instructions");
        assert_eq!(history[1].fingerprint, "first-fingerprint");
        assert_eq!(history[1].input, "First draft");
        assert_eq!(history[1].output, "First review");
    }
}
