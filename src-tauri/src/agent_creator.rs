use crate::{
    AgentFrontmatter, AgentSummary, agent_template_body, authorized_relative_dir, canonical_dir,
    err, inspect_agent, safe_relative, scan_library, skill_runs, slug, valid_agent_model,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDraft {
    name: String,
    description: String,
    template: String,
    responsibilities: String,
    boundaries: String,
    handoff: String,
    category: String,
    new_folder: String,
    model: String,
    tools: Vec<String>,
    skills: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentPreview {
    relative_path: String,
    source: String,
}

struct PreparedAgent {
    parent: PathBuf,
    new_folder: Option<String>,
    filename: String,
    preview: AgentPreview,
}

fn prepare(root: &Path, draft: AgentDraft) -> Result<PreparedAgent, String> {
    let name = draft.name.trim().replace(['\r', '\n'], " ");
    let id = slug(&name)?;
    let description = draft.description.trim().replace(['\r', '\n'], " ");
    if id.len() > 64 || description.is_empty() || description.chars().count() > 400 {
        return Err(
            "Use an agent ID up to 64 characters and a description of 1–400 characters.".into(),
        );
    }
    if !matches!(
        draft.template.as_str(),
        "specialist" | "reviewer" | "researcher" | "planner"
    ) {
        return Err("Choose a supported starting role.".into());
    }
    if !valid_agent_model(&draft.model) {
        return Err("Choose a supported Claude Code model.".into());
    }
    if draft.tools.iter().any(|tool| {
        !matches!(
            tool.as_str(),
            "Read" | "Grep" | "Glob" | "Edit" | "Write" | "Bash" | "WebSearch" | "WebFetch"
        )
    }) {
        return Err("Choose tools from the available tool list.".into());
    }
    if draft.skills.len() > 16 {
        return Err("Choose up to 16 referenced skills.".into());
    }
    let parent = safe_relative(&draft.category)?;
    let agent_root = root.join("agents");
    if agent_root.exists() {
        let agent_root = canonical_dir(&agent_root)?;
        if !agent_root.starts_with(root) {
            return Err("The agents folder resolves outside the library.".into());
        }
        authorized_relative_dir(&agent_root, &parent)?;
    } else if !parent.as_os_str().is_empty() {
        return Err("The selected agent folder no longer exists.".into());
    }
    let new_folder = if draft.new_folder.trim().is_empty() {
        None
    } else {
        Some(slug(&draft.new_folder)?)
    };
    let destination_dir = new_folder
        .as_ref()
        .map_or_else(|| parent.clone(), |folder| parent.join(folder));
    if new_folder.is_some() && agent_root.join(&destination_dir).symlink_metadata().is_ok() {
        return Err("That folder already exists. Select it from the folder list.".into());
    }
    let filename = format!("{id}.md");
    let library = scan_library(root.to_string_lossy().into_owned())?;
    if library.agents.iter().any(|agent| {
        slug(&agent.name).is_ok_and(|existing| existing == id)
            || Path::new(&agent.path)
                .file_name()
                .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(&filename))
    }) {
        return Err(format!(
            "An agent with ID “{id}” already exists. Choose a different name."
        ));
    }
    for skill in &draft.skills {
        let reference = skill_runs::referenced_skill(skill, &library.skills)?;
        if reference.status != "valid" {
            return Err(format!(
                "Fix the referenced skill “{skill}” before adding it to an agent."
            ));
        }
    }

    let fields = [
        ("Responsibilities", draft.responsibilities),
        ("Role-specific boundaries", draft.boundaries),
        ("Workflow handoff", draft.handoff),
    ];
    if fields.iter().any(|(_, value)| value.chars().count() > 1500) {
        return Err("Keep each optional instruction field under 1,500 characters.".into());
    }
    let frontmatter = AgentFrontmatter {
        name: Some(id),
        description: Some(description),
        model: Some(draft.model),
        tools: draft.tools,
        skills: draft.skills,
    };
    let yaml = serde_yaml::to_string(&frontmatter).map_err(err)?;
    let mut body = agent_template_body(Some(&draft.template), &name);
    for (heading, value) in fields {
        if !value.trim().is_empty() {
            body.push_str(&format!("\n## {heading}\n\n{}\n", value.trim()));
        }
    }
    let relative_path = Path::new("agents")
        .join(destination_dir)
        .join(&filename)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(PreparedAgent {
        parent,
        new_folder,
        filename,
        preview: AgentPreview {
            relative_path,
            source: format!("---\n{yaml}---\n\n{body}"),
        },
    })
}

#[tauri::command]
pub(crate) async fn preview_agent(root: String, draft: AgentDraft) -> Result<AgentPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(prepare(&canonical_dir(Path::new(&root))?, draft)?.preview)
    })
    .await
    .map_err(err)?
}

fn create(root: &Path, draft: AgentDraft) -> Result<AgentSummary, String> {
    let prepared = prepare(root, draft)?;
    let agent_root = root.join("agents");
    fs::create_dir_all(&agent_root).map_err(err)?;
    let agent_root = authorized_relative_dir(root, Path::new("agents"))?;
    let parent = authorized_relative_dir(&agent_root, &prepared.parent)?;
    let created_folder = if let Some(folder) = prepared.new_folder {
        let path = parent.join(folder);
        fs::create_dir(&path).map_err(err)?;
        Some(path)
    } else {
        None
    };
    let destination = created_folder
        .as_ref()
        .unwrap_or(&parent)
        .join(prepared.filename);
    let result = fs::File::create_new(&destination).and_then(|mut file| {
        let result = file
            .write_all(prepared.preview.source.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if result.is_err() {
            let _ = fs::remove_file(&destination);
        }
        result
    });
    if let Err(error) = result {
        if let Some(folder) = created_folder {
            let _ = fs::remove_dir(folder);
        }
        return Err(err(error));
    }
    Ok(inspect_agent(&agent_root, &destination))
}

#[tauri::command]
pub(crate) async fn create_agent(root: String, draft: AgentDraft) -> Result<AgentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || create(&canonical_dir(Path::new(&root))?, draft))
        .await
        .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creator_previews_written_markdown_and_checks_duplicate_ids() {
        let directory = std::env::temp_dir().join(format!(
            "command-center-creator-{}-{}",
            std::process::id(),
            std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let exercise = || -> Result<(String, String, bool), String> {
            let root = canonical_dir(&directory)?;
            let skill = root.join("proposal-review");
            fs::create_dir(&skill).map_err(err)?;
            fs::write(skill.join("SKILL.md"), "---\nname: Review Criteria\ndescription: Check proposal criteria.\n---\nUse the checklist.").map_err(err)?;
            let draft = || AgentDraft {
                name: "Proposal Reviewer".into(),
                description: "Check proposals: find gaps.".into(),
                template: "reviewer".into(),
                responsibilities: "Check whether scope is explicit.".into(),
                boundaries: String::new(),
                handoff: "Return review findings to the drafter.".into(),
                category: String::new(),
                new_folder: "Delivery Team".into(),
                model: "inherit".into(),
                tools: vec!["Read".into()],
                skills: vec!["proposal-review".into()],
            };
            let preview = prepare(&root, draft())?.preview;
            if root.join("agents").exists()
                || preview.relative_path != "agents/delivery-team/proposal-reviewer.md"
            {
                return Err("Preview created a folder or showed an unexpected path.".into());
            }
            let agent = create(&root, draft())?;
            let written = fs::read_to_string(agent.path).map_err(err)?;
            let mut duplicate = draft();
            duplicate.new_folder = "Different team".into();
            let rejected =
                create(&root, duplicate).is_err() && !root.join("agents/different-team").exists();
            Ok((preview.source, written, rejected))
        };
        let result = exercise();
        fs::remove_dir_all(directory).unwrap();
        let (preview, written, rejected) = result.unwrap();
        assert_eq!(preview, written);
        assert!(written.contains("name: proposal-reviewer"));
        assert!(written.contains("Return review findings to the drafter."));
        assert!(written.contains("- proposal-review"));
        assert!(rejected);
    }
}
