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
const MAX_SOURCE_CHARS: usize = 8_000;
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RunKind {
    #[default]
    Skill,
    Agent,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    #[default]
    Ollama,
    OpenAi,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferencedSkill {
    name: String,
    relative_path: String,
    fingerprint: String,
    source: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestRun {
    id: String,
    timestamp: u64,
    #[serde(default)]
    kind: RunKind,
    #[serde(default)]
    provider: Provider,
    #[serde(alias = "skillName")]
    asset_name: String,
    #[serde(alias = "skillPath")]
    asset_path: String,
    fingerprint: String,
    #[serde(alias = "skillSource")]
    asset_source: String,
    #[serde(default)]
    referenced_skills: Vec<ReferencedSkill>,
    model: String,
    input: String,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResult {
    run: TestRun,
    save_error: Option<String>,
}

pub(crate) fn history_directory(
    app_data: &Path,
    library: &str,
    category: &str,
) -> Result<PathBuf, String> {
    let root = super::canonical_dir(Path::new(library))?;
    Ok(app_data
        .join(category)
        .join(super::fingerprint(&root.to_string_lossy())))
}

pub(crate) fn save_run(directory: &Path, id: &str, run: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(run).map_err(super::err)?;
    fs::create_dir_all(directory).map_err(super::err)?;
    let temporary = directory.join(format!("{}.tmp", run_identity()?.0));
    let result = {
        let mut file = fs::File::create_new(&temporary).map_err(super::err)?;
        file.write_all(&bytes).and_then(|()| file.sync_all())
    };
    let result = result.and_then(|()| fs::rename(&temporary, directory.join(format!("{id}.json"))));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(super::err)
}

pub(crate) fn recent_runs<T: serde::de::DeserializeOwned>(
    directory: &Path,
) -> Result<Vec<T>, String> {
    stored_runs(directory, RECENT_RUNS)
}

pub(crate) fn stored_runs<T: serde::de::DeserializeOwned>(
    directory: &Path,
    limit: usize,
) -> Result<Vec<T>, String> {
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
        .take(limit)
        .map(|path| {
            let file = fs::File::open(path).map_err(super::err)?;
            serde_json::from_reader(file).map_err(super::err)
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn list_runs(
    app: tauri::AppHandle,
    library_root: String,
) -> Result<Vec<TestRun>, String> {
    let app_data = app.path().app_data_dir().map_err(super::err)?;
    tauri::async_runtime::spawn_blocking(move || {
        recent_runs(&history_directory(&app_data, &library_root, "skill-runs")?)
    })
    .await
    .map_err(super::err)?
}

pub(crate) struct AssetSnapshot {
    pub(crate) name: String,
    path: String,
    pub(crate) fingerprint: String,
    source: String,
    referenced_skills: Vec<ReferencedSkill>,
}

impl AssetSnapshot {
    pub(crate) fn instructions(&self) -> String {
        let mut instructions = self.source.clone();
        for skill in &self.referenced_skills {
            instructions.push_str(&format!(
                "\n\nReferenced skill: {}\n\n{}",
                skill.name, skill.source
            ));
        }
        instructions
    }
}

fn read_skill_snapshot(root: &str, path: &str) -> Result<AssetSnapshot, String> {
    let skill = super::read_skill(root.to_owned(), path.to_owned())?;
    let fields = super::split_frontmatter(&skill.content)?;
    if fields
        .name
        .as_deref()
        .is_none_or(|name| name.trim().is_empty())
        || fields
            .description
            .as_deref()
            .is_none_or(|description| description.trim().is_empty())
    {
        return Err("A test skill must have a name and description.".into());
    }
    Ok(AssetSnapshot {
        name: fields.name.unwrap(),
        path: skill.path,
        source: skill.content,
        fingerprint: skill.fingerprint,
        referenced_skills: Vec::new(),
    })
}

pub(crate) fn referenced_skill<'a>(
    reference: &str,
    skills: &'a [super::Skill],
) -> Result<&'a super::Skill, String> {
    let mut matches = skills.iter().filter(|skill| {
        skill.name.eq_ignore_ascii_case(reference)
            || Path::new(&skill.path)
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(reference))
    });
    let skill = matches.next().ok_or_else(|| format!("Referenced skill “{reference}” was not found. Update the agent’s skills list or add the skill to this library."))?;
    if matches.next().is_some() {
        return Err(format!(
            "Referenced skill “{reference}” matches more than one library skill. Give it a unique name."
        ));
    }
    Ok(skill)
}

pub(crate) fn load_snapshot(
    root: &str,
    path: &str,
    kind: RunKind,
) -> Result<AssetSnapshot, String> {
    match kind {
        RunKind::Skill => read_skill_snapshot(root, path),
        RunKind::Agent => {
            let agent = super::read_agent(root.to_owned(), path.to_owned())?;
            let fields = super::split_agent_frontmatter(&agent.content)?;
            if agent.status != "valid" {
                return Err("Fix the agent’s validation errors before testing.".into());
            }
            let mut total_chars = agent.content.chars().count();
            if total_chars > MAX_SOURCE_CHARS || fields.skills.len() > 16 {
                return Err(
                    "Use an agent under 8,000 characters with at most 16 referenced skills.".into(),
                );
            }
            let mut referenced_skills = Vec::new();
            let mut paths = std::collections::HashSet::new();
            if !fields.skills.is_empty() {
                let library = super::scan_library(root.to_owned())?;
                for reference in fields.skills {
                    let skill = referenced_skill(&reference, &library.skills)?;
                    if paths.insert(&skill.path) {
                        let snapshot = read_skill_snapshot(root, &skill.path)?;
                        total_chars += snapshot.source.chars().count();
                        if total_chars > MAX_SOURCE_CHARS {
                            return Err("Use fewer or shorter referenced skills. Combined test source is limited to 8,000 characters.".into());
                        }
                        referenced_skills.push(ReferencedSkill {
                            name: snapshot.name,
                            relative_path: skill.relative_path.clone(),
                            fingerprint: snapshot.fingerprint,
                            source: snapshot.source,
                        });
                    }
                }
            }
            Ok(AssetSnapshot {
                name: agent.name,
                path: agent.path,
                fingerprint: agent.fingerprint,
                source: agent.content,
                referenced_skills,
            })
        }
    }
}

pub(crate) async fn generate(
    provider: Provider,
    model: &str,
    system: &str,
    input: &str,
) -> Result<String, String> {
    match provider {
        Provider::Ollama => super::ollama::generate(model, system, input).await,
        Provider::OpenAi => super::openai::generate(model, system, input).await,
    }
}

pub(crate) fn run_identity() -> Result<(String, u64), String> {
    let timestamp = UNIX_EPOCH.elapsed().map_err(super::err)?.as_millis() as u64;
    let sequence = RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok((
        format!("{timestamp:020}-{:010}-{sequence:020}", std::process::id()),
        timestamp,
    ))
}

#[tauri::command]
pub(crate) async fn run_test(
    app: tauri::AppHandle,
    library_root: String,
    asset_path: String,
    kind: RunKind,
    provider: Provider,
    model: String,
    input: String,
) -> Result<RunResult, String> {
    let input = input.trim().to_owned();
    if input.is_empty() || input.chars().count() > 4_000 {
        return Err("Enter an example input of up to 4,000 characters.".into());
    }
    let app_data = app.path().app_data_dir().map_err(super::err)?;
    let (directory, asset) = tauri::async_runtime::spawn_blocking(move || {
        let directory = history_directory(&app_data, &library_root, "skill-runs")?;
        let asset = load_snapshot(&library_root, &asset_path, kind)?;
        Ok::<_, String>((directory, asset))
    })
    .await
    .map_err(super::err)??;
    if asset.source.chars().count() > MAX_SOURCE_CHARS {
        return Err("Choose a saved asset with source under 8,000 characters.".into());
    }
    let model = model.trim().to_owned();
    if model.is_empty() || model.len() > 150 {
        return Err("Enter a model name up to 150 bytes.".into());
    }
    let system = format!(
        "Respond to the example input using the saved instructions below. This is a text-only preview. If the instructions call for tools or external actions, explain what additional access you would need.\n\n{}",
        asset.instructions()
    );
    let output = generate(provider, &model, &system, &input).await?;
    let (id, timestamp) = run_identity()?;
    let run = TestRun {
        id,
        timestamp,
        kind,
        provider,
        asset_name: asset.name,
        asset_path: asset.path,
        fingerprint: asset.fingerprint,
        asset_source: asset.source,
        referenced_skills: asset.referenced_skills,
        model,
        input,
        output,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let save_error = save_run(&directory, &run.id, &run).err();
        RunResult { run, save_error }
    })
    .await
    .map_err(super::err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_snapshot_resolves_skill_folder_names_and_rejects_missing_references() {
        let root = std::env::temp_dir().join(format!(
            "command-center-agent-run-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos(),
        ));
        let exercise = || -> Result<(AssetSnapshot, Result<AssetSnapshot, String>), String> {
            let skill = root.join("review");
            let agent = root.join("agents").join("editor.md");
            fs::create_dir_all(&skill).map_err(super::super::err)?;
            fs::create_dir_all(root.join("agents")).map_err(super::super::err)?;
            fs::write(
                skill.join("SKILL.md"),
                "---\nname: Review Drafts\ndescription: Reviews drafts.\n---\nReview the draft.",
            )
            .map_err(super::super::err)?;
            let write_agent = |reference: &str| {
                fs::write(&agent, format!(
                "---\nname: editor\ndescription: Edits drafts.\nskills: [{reference}]\n---\nEdit the draft."
            )).map_err(super::super::err)
            };
            write_agent("review")?;
            let snapshot = load_snapshot(
                &root.to_string_lossy(),
                &agent.to_string_lossy(),
                RunKind::Agent,
            )?;
            write_agent("missing")?;
            let missing = load_snapshot(
                &root.to_string_lossy(),
                &agent.to_string_lossy(),
                RunKind::Agent,
            );
            Ok((snapshot, missing))
        };
        let result = exercise();
        fs::remove_dir_all(root).unwrap();
        let (snapshot, missing) = result.unwrap();
        assert_eq!(snapshot.referenced_skills.len(), 1);
        assert_eq!(snapshot.referenced_skills[0].name, "Review Drafts");
        assert!(
            snapshot.referenced_skills[0]
                .source
                .ends_with("Review the draft.")
        );
        assert!(
            matches!(missing, Err(message) if message.contains("Referenced skill “missing” was not found"))
        );
    }

    #[test]
    fn history_keeps_exact_skill_and_input_snapshots() {
        let directory = std::env::temp_dir().join(format!(
            "command-center-history-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let exercise =
            || -> Result<Vec<TestRun>, String> {
                fs::write(directory.join("001.json"), serde_json::json!({
                "id": "001", "timestamp": 1, "skillName": "Reviewer", "skillPath": "reviewer",
                "fingerprint": "first-fingerprint", "skillSource": "First instructions",
                "model": "gemma3:4b", "input": "First draft", "output": "First review"
            }).to_string()).map_err(super::super::err)?;
                let run = TestRun {
                    id: "002".into(),
                    timestamp: 2,
                    kind: RunKind::Agent,
                    provider: Provider::OpenAi,
                    asset_name: "Reviewer".into(),
                    asset_path: "reviewer".into(),
                    fingerprint: "second-fingerprint".into(),
                    asset_source: "Updated instructions".into(),
                    referenced_skills: vec![ReferencedSkill {
                        name: "Review".into(),
                        relative_path: "review".into(),
                        fingerprint: "reference-fingerprint".into(),
                        source: "Referenced instructions".into(),
                    }],
                    model: "gpt-4.1-mini".into(),
                    input: "First draft".into(),
                    output: "First review".into(),
                };
                save_run(&directory, &run.id, &run)?;
                fs::write(directory.join("incomplete.tmp"), "{").map_err(super::super::err)?;
                recent_runs(&directory)
            };
        let history = exercise();
        fs::remove_dir_all(directory).unwrap();
        let history = history.unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].asset_source, "Updated instructions");
        assert!(matches!(history[0].provider, Provider::OpenAi));
        assert_eq!(
            history[0].referenced_skills[0].source,
            "Referenced instructions"
        );
        assert_eq!(history[1].asset_source, "First instructions");
        assert!(matches!(history[1].kind, RunKind::Skill));
        assert!(matches!(history[1].provider, Provider::Ollama));
        assert_eq!(history[1].fingerprint, "first-fingerprint");
        assert_eq!(history[1].input, "First draft");
        assert_eq!(history[1].output, "First review");
    }
}
