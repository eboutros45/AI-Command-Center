use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

mod activity;
mod agent_creator;
mod knowledge;
mod ollama;
mod openai;
mod skill_runs;
mod workflows;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Skill {
    name: String,
    description: String,
    path: String,
    relative_path: String,
    modified: u64,
    status: String,
    errors: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillDocument {
    name: String,
    description: String,
    path: String,
    relative_path: String,
    modified: u64,
    status: String,
    errors: Vec<String>,
    content: String,
    fingerprint: String,
    files: Vec<String>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Category {
    name: String,
    path: String,
    relative_path: String,
    children: Vec<Category>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    root: String,
    categories: Vec<Category>,
    skills: Vec<Skill>,
    agent_categories: Vec<Category>,
    agents: Vec<AgentSummary>,
}
#[derive(Default, Deserialize, Serialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillPreferences {
    #[serde(default)]
    activation: String,
    #[serde(default)]
    tone: String,
    #[serde(default)]
    output_format: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentFrontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "deserialize_string_list"
    )]
    tools: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "deserialize_string_list"
    )]
    skills: Vec<String>,
}

fn deserialize_string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringList {
        One(String),
        Many(Vec<String>),
    }
    let value = Option::<StringList>::deserialize(deserializer)?;
    Ok(match value {
        Some(StringList::One(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        Some(StringList::Many(values)) => values,
        None => Vec::new(),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentSummary {
    name: String,
    description: String,
    path: String,
    relative_path: String,
    modified: u64,
    status: String,
    errors: Vec<String>,
    model: String,
    tools: Vec<String>,
    skills: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDocument {
    name: String,
    description: String,
    path: String,
    relative_path: String,
    modified: u64,
    status: String,
    errors: Vec<String>,
    model: String,
    tools: Vec<String>,
    skills: Vec<String>,
    content: String,
    fingerprint: String,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("Folder is unavailable: {}", path.display()));
    }
    dunce::canonicalize(path).map_err(err)
}
fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Unsafe relative path".into());
    }
    Ok(path.to_path_buf())
}
fn within(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(root)?;
    let candidate = dunce::canonicalize(candidate).map_err(err)?;
    if !candidate.starts_with(&root) {
        return Err("Path is outside the selected library".into());
    }
    Ok(candidate)
}

fn authorized_relative_dir(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let root = canonical_dir(root)?;
    let candidate = canonical_dir(&root.join(relative))?;
    if !candidate.starts_with(&root) {
        return Err("Folder resolves outside the selected library".into());
    }
    Ok(candidate)
}
fn slug(value: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut dash = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            dash = false;
        } else if !dash && !output.is_empty() {
            output.push('-');
            dash = true;
        }
    }
    let result = output.trim_matches('-').to_string();
    if result.is_empty() || result == "synced" || result == "anthropic-skills" {
        return Err("Name cannot be used as a Claude skill folder".into());
    }
    Ok(result)
}
fn split_frontmatter(content: &str) -> Result<Frontmatter, String> {
    let yaml = frontmatter_yaml(content, "SKILL.md")?;
    serde_yaml::from_str(yaml).map_err(|error| format!("Invalid YAML frontmatter: {error}"))
}
fn frontmatter_yaml<'a>(content: &'a str, filename: &str) -> Result<&'a str, String> {
    if !content.starts_with("---\n") {
        return Err(format!("{filename} must begin with YAML frontmatter"));
    }
    let rest = &content[4..];
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(|value| value.len()))
        .ok_or("Frontmatter has no closing ---")?;
    Ok(&rest[..end])
}
fn split_agent_frontmatter(content: &str) -> Result<AgentFrontmatter, String> {
    let yaml = frontmatter_yaml(content, "Agent file")?;
    serde_yaml::from_str(yaml).map_err(|error| format!("Invalid YAML frontmatter: {error}"))
}
fn inspect(root: &Path, dir: &Path) -> Skill {
    let entry = dir.join("SKILL.md");
    let relative = dir
        .strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/");
    let modified = fs::metadata(&entry)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let fallback = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let mut name = fallback;
    let mut description = String::new();
    let mut errors = vec![];
    match fs::read_to_string(&entry) {
        Ok(content) => match split_frontmatter(&content) {
            Ok(frontmatter) => {
                match frontmatter.name.filter(|v| !v.trim().is_empty()) {
                    Some(value) => name = value,
                    None => errors.push("Missing required frontmatter: name".into()),
                }
                match frontmatter.description.filter(|v| !v.trim().is_empty()) {
                    Some(value) => description = value,
                    None => errors.push("Missing required frontmatter: description".into()),
                }
            }
            Err(error) => errors.push(error),
        },
        Err(error) => errors.push(format!("Cannot read SKILL.md: {error}")),
    }
    Skill {
        name,
        description,
        path: dir.to_string_lossy().into(),
        relative_path: relative,
        modified,
        status: if errors.is_empty() {
            "valid"
        } else {
            "invalid"
        }
        .into(),
        errors,
    }
}

fn valid_agent_model(model: &str) -> bool {
    matches!(model, "inherit" | "sonnet" | "opus" | "haiku" | "fable")
        || model.starts_with("claude-")
}

fn inspect_agent(agent_root: &Path, file: &Path) -> AgentSummary {
    let relative = file
        .strip_prefix(agent_root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    let modified = fs::metadata(file)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_secs());
    let fallback = file
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let mut name = fallback;
    let mut description = String::new();
    let mut model = "inherit".to_string();
    let mut tools = Vec::new();
    let mut skills = Vec::new();
    let mut errors = Vec::new();
    match fs::read_to_string(file) {
        Ok(content) => match split_agent_frontmatter(&content) {
            Ok(frontmatter) => {
                match frontmatter.name.filter(|value| !value.trim().is_empty()) {
                    Some(value) => name = value,
                    None => errors.push("Missing required frontmatter: name".into()),
                }
                match frontmatter
                    .description
                    .filter(|value| !value.trim().is_empty())
                {
                    Some(value) => description = value,
                    None => errors.push("Missing required frontmatter: description".into()),
                }
                if let Some(value) = frontmatter.model.filter(|value| !value.trim().is_empty()) {
                    model = value;
                }
                tools = frontmatter.tools;
                skills = frontmatter.skills;
            }
            Err(error) => errors.push(error),
        },
        Err(error) => errors.push(format!("Cannot read agent file: {error}")),
    }
    if name.starts_with('-') || name.contains(':') || name.len() > 256 {
        errors
            .push("Agent name cannot start with '-', contain ':', or exceed 256 characters".into());
    }
    if !valid_agent_model(&model) {
        errors.push(format!("Unsupported Claude model value: {model}"));
    }
    AgentSummary {
        name,
        description,
        path: file.to_string_lossy().into_owned(),
        relative_path: relative,
        modified,
        status: if errors.is_empty() {
            "valid"
        } else {
            "invalid"
        }
        .into(),
        errors,
        model,
        tools,
        skills,
    }
}
fn fingerprint(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
fn list_files(dir: &Path) -> Vec<String> {
    WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(dir)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect()
}
fn category_tree(root: &Path, skill_dirs: &[PathBuf]) -> Vec<Category> {
    fn children(root: &Path, current: &Path, skill_dirs: &[PathBuf]) -> Vec<Category> {
        let mut result = vec![];
        let Ok(entries) = fs::read_dir(current) else {
            return result;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir())
                || entry.file_name().to_string_lossy().starts_with('.')
                || skill_dirs.iter().any(|s| s == &path)
            {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            result.push(Category {
                name: entry.file_name().to_string_lossy().into(),
                path: path.to_string_lossy().into(),
                relative_path: relative,
                children: children(root, &path, skill_dirs),
            });
        }
        result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        result
    }
    children(root, root, skill_dirs)
}

#[tauri::command]
fn scan_library(root: String) -> Result<Library, String> {
    let root = canonical_dir(Path::new(&root))?;
    let mut skill_dirs = vec![];
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || (entry.path() != root.join("agents")
                    && !entry.file_name().to_string_lossy().starts_with('.'))
        })
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() && entry.file_name() == "SKILL.md" {
            if let Some(parent) = entry.path().parent() {
                skill_dirs.push(parent.to_path_buf());
            }
        }
    }
    skill_dirs.sort();
    skill_dirs.dedup();
    let mut skills: Vec<_> = skill_dirs.iter().map(|path| inspect(&root, path)).collect();
    skills.sort_by(|a, b| b.modified.cmp(&a.modified));
    let agent_root = root.join("agents");
    let mut agents = Vec::new();
    if agent_root.is_dir() {
        for entry in WalkDir::new(&agent_root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("md")
            {
                agents.push(inspect_agent(&agent_root, entry.path()));
            }
        }
    }
    let mut counts = BTreeMap::new();
    for agent in &agents {
        *counts.entry(agent.name.to_lowercase()).or_insert(0usize) += 1;
    }
    for agent in &mut agents {
        if counts
            .get(&agent.name.to_lowercase())
            .copied()
            .unwrap_or_default()
            > 1
        {
            agent
                .errors
                .push("Agent name is duplicated in this library".into());
            agent.status = "invalid".into();
        }
    }
    agents.sort_by(|a, b| b.modified.cmp(&a.modified));
    let mut categories = category_tree(&root, &skill_dirs);
    categories.retain(|category| category.relative_path != "agents");
    Ok(Library {
        root: root.to_string_lossy().into(),
        categories,
        skills,
        agent_categories: if agent_root.is_dir() {
            category_tree(&agent_root, &[])
        } else {
            Vec::new()
        },
        agents,
    })
}

#[tauri::command]
fn read_skill(root: String, skill_path: String) -> Result<SkillDocument, String> {
    let root = canonical_dir(Path::new(&root))?;
    let dir = within(&root, Path::new(&skill_path))?;
    let entry = within(&dir, &dir.join("SKILL.md"))?;
    let content = fs::read_to_string(entry).map_err(err)?;
    let skill = inspect(&root, &dir);
    Ok(SkillDocument {
        name: skill.name,
        description: skill.description,
        path: skill.path,
        relative_path: skill.relative_path,
        modified: skill.modified,
        status: skill.status,
        errors: skill.errors,
        fingerprint: fingerprint(&content),
        content,
        files: list_files(&dir),
    })
}

#[tauri::command]
fn save_skill(
    root: String,
    skill_path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<SkillDocument, String> {
    let root_path = canonical_dir(Path::new(&root))?;
    let dir = within(&root_path, Path::new(&skill_path))?;
    let file = dir.join("SKILL.md");
    let current = fs::read_to_string(&file).map_err(err)?;
    if fingerprint(&current) != expected_fingerprint {
        return Err("SKILL.md changed outside the app. Reload it before saving, or explicitly resolve the conflict.".into());
    }
    let temp = dir.join(".SKILL.md.command-center.tmp");
    fs::write(&temp, content.as_bytes()).map_err(err)?;
    fs::rename(&temp, &file).map_err(err)?;
    read_skill(root, skill_path)
}

#[tauri::command]
fn create_category(root: String, parent: String, name: String) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let parent = safe_relative(&parent)?;
    let parent = authorized_relative_dir(&root, &parent)?;
    let name = slug(&name)?;
    let destination = parent.join(name);
    if destination.exists() {
        return Err("A folder with that name already exists".into());
    }
    fs::create_dir(&destination).map_err(err)?;
    Ok(destination.to_string_lossy().into())
}

#[tauri::command]
fn create_agent_category(root: String, parent: String, name: String) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let agent_root = root.join("agents");
    fs::create_dir_all(&agent_root).map_err(err)?;
    let agent_root = canonical_dir(&agent_root)?;
    let parent = safe_relative(&parent)?;
    let parent = authorized_relative_dir(&agent_root, &parent)?;
    let destination = parent.join(slug(&name)?);
    if destination.exists() {
        return Err("An agent folder with that name already exists".into());
    }
    fs::create_dir(&destination).map_err(err)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_skill(
    root: String,
    category: String,
    name: String,
    description: String,
    template: Option<String>,
    preferences: Option<SkillPreferences>,
) -> Result<Skill, String> {
    let root = canonical_dir(Path::new(&root))?;
    let category = safe_relative(&category)?;
    let category = authorized_relative_dir(&root, &category)?;
    let category = category.strip_prefix(&root).map_err(err)?.to_path_buf();
    create_skill_at(
        &root,
        &category,
        &name,
        &description,
        template.as_deref(),
        preferences.as_ref(),
    )
}

fn append_preferences(mut body: String, preferences: Option<&SkillPreferences>) -> String {
    let Some(preferences) = preferences else {
        return body;
    };
    let clean = |value: &str| value.trim().replace(['\r', '\n'], " ");
    let activation = clean(&preferences.activation);
    let tone = clean(&preferences.tone);
    let output_format = clean(&preferences.output_format);
    let instructions = preferences.instructions.trim();
    if !activation.is_empty() {
        body.push_str(&format!(
            "\n## Personal activation guidance\n\nUse this skill when {activation}.\n"
        ));
    }
    if !tone.is_empty() || !output_format.is_empty() {
        body.push_str("\n## Response preferences\n\n");
        if !tone.is_empty() {
            body.push_str(&format!("- Style: {tone}\n"));
        }
        if !output_format.is_empty() {
            body.push_str(&format!("- Deliverable: {output_format}\n"));
        }
    }
    if !instructions.is_empty() {
        body.push_str(&format!("\n## Personal instructions\n\n{}\n", instructions));
    }
    body
}

fn template_body(template: Option<&str>, name: &str) -> String {
    match template.unwrap_or("general") {
        "review" => format!(
            "# {name}\n\n## When to use\n\nUse this skill when the user asks for a structured review.\n\n## Process\n\n1. Establish the goal and relevant constraints.\n2. Inspect the supplied material before drawing conclusions.\n3. Prioritize findings by impact and confidence.\n4. Cite concrete evidence for each finding.\n5. End with concise recommended next steps.\n\n## Output\n\nLead with actionable findings. Separate confirmed issues from suggestions.\n"
        ),
        "research" => format!(
            "# {name}\n\n## When to use\n\nUse this skill when the user needs evidence gathered and synthesized.\n\n## Process\n\n1. Restate the research question and scope.\n2. Prefer primary and current sources.\n3. Record claims with their supporting sources.\n4. Reconcile conflicts and call out uncertainty.\n5. Summarize the answer and remaining gaps.\n\n## Output\n\nProvide a concise synthesis, key evidence, sources, and open questions.\n"
        ),
        "planning" => format!(
            "# {name}\n\n## When to use\n\nUse this skill when a goal needs to become an executable plan.\n\n## Process\n\n1. Confirm the desired outcome and constraints.\n2. Identify dependencies, risks, and unknowns.\n3. Break work into verifiable milestones.\n4. Define acceptance checks for each milestone.\n5. Highlight decisions requiring human approval.\n\n## Output\n\nReturn an ordered plan with outcomes, checks, risks, and decisions.\n"
        ),
        "skill-creator" => format!(
            "# {name}\n\n## Purpose\n\nHelp create or improve portable AI skills that follow the Agent Skills format.\n\n## Process\n\n1. Clarify the capability, trigger conditions, and expected outcome.\n2. Keep `SKILL.md` focused; place detailed material in supporting files.\n3. Write a precise description that tells Claude when to use the skill.\n4. Use imperative, testable instructions and explicit output requirements.\n5. Validate frontmatter, relative references, and portability before publishing.\n\n## Quality checklist\n\n- The description states what the skill does and when to use it.\n- Instructions contain no hidden assumptions or environment-specific paths.\n- Scripts are never executed during inspection or import.\n- Examples and references are included only when they improve reliability.\n"
        ),
        _ => format!(
            "# {name}\n\n## When to use\n\nDescribe the requests and situations that should activate this skill.\n\n## Instructions\n\n1. Confirm the desired outcome and relevant constraints.\n2. Follow a clear, repeatable process.\n3. Verify the result before responding.\n\n## Output\n\nDescribe the expected response format and quality bar.\n"
        ),
    }
}

fn create_skill_at(
    root: &Path,
    category: &Path,
    name: &str,
    description: &str,
    template: Option<&str>,
    preferences: Option<&SkillPreferences>,
) -> Result<Skill, String> {
    let folder = slug(&name)?;
    let destination = root.join(category).join(&folder);
    if destination.exists() {
        return Err("A skill with that folder name already exists".into());
    }
    fs::create_dir(&destination).map_err(err)?;
    let safe_name = name.replace(['\n', '\r'], " ");
    let safe_description = description.replace(['\n', '\r'], " ");
    let body = append_preferences(template_body(template, &safe_name), preferences);
    let frontmatter = Frontmatter {
        name: Some(safe_name.clone()),
        description: Some(safe_description),
    };
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| format!("Could not serialize skill frontmatter: {error}"))?;
    fs::write(
        destination.join("SKILL.md"),
        format!("---\n{yaml}---\n\n{body}"),
    )
    .map_err(err)?;
    Ok(inspect(&root, &destination))
}

#[tauri::command]
fn seed_starter_skills(root: String) -> Result<Vec<Skill>, String> {
    let root = canonical_dir(Path::new(&root))?;
    let category = Path::new("starter-skills");
    fs::create_dir_all(root.join(category)).map_err(err)?;
    let starters = [
        (
            "Skill Creator",
            "Creates and improves portable AI skills. Use when defining a reusable capability or refining SKILL.md instructions.",
            "skill-creator",
        ),
        (
            "Code Review",
            "Reviews code for correctness, security, maintainability, and missing tests. Use when the user requests review feedback.",
            "review",
        ),
        (
            "Research Synthesizer",
            "Researches a question and produces an evidence-based synthesis with sources and uncertainty noted.",
            "research",
        ),
        (
            "Project Planner",
            "Turns a goal into a sequenced, verifiable implementation plan with risks and approval decisions.",
            "planning",
        ),
    ];
    let mut created = Vec::new();
    for (name, description, template) in starters {
        if !root.join(category).join(slug(name)?).exists() {
            created.push(create_skill_at(
                &root,
                category,
                name,
                description,
                Some(template),
                None,
            )?);
        }
    }
    Ok(created)
}

fn agent_template_body(template: Option<&str>, name: &str) -> String {
    match template.unwrap_or("specialist") {
        "reviewer" => format!(
            "# {name}\n\nYou are a rigorous reviewer. Establish the intended outcome before evaluating the work. Inspect the available evidence, prioritize findings by impact, and distinguish confirmed defects from optional improvements.\n\n## Operating process\n\n1. Confirm the goal, scope, and relevant constraints.\n2. Inspect the supplied material before reaching conclusions.\n3. Identify correctness, safety, maintainability, and verification gaps.\n4. Cite concrete evidence for every material finding.\n5. Recommend the smallest effective next steps.\n\n## Boundaries\n\nDo not change files or external state unless the user explicitly asks. State uncertainty when evidence is incomplete.\n\n## Output contract\n\nLead with prioritized findings, followed by assumptions, recommended actions, and verification steps.\n"
        ),
        "researcher" => format!(
            "# {name}\n\nYou are an evidence-first research specialist. Turn broad questions into a clear research scope, prefer primary sources, reconcile conflicting claims, and make uncertainty visible.\n\n## Operating process\n\n1. Define the question, audience, timeframe, and decision it supports.\n2. Gather the most authoritative and current evidence available.\n3. Track each important claim to its source.\n4. Compare conflicting evidence and explain the difference.\n5. Synthesize conclusions and identify remaining gaps.\n\n## Boundaries\n\nNever invent citations or imply that an unverified claim is established fact.\n\n## Output contract\n\nProvide a concise synthesis, key evidence, sources, confidence, and open questions.\n"
        ),
        "planner" => format!(
            "# {name}\n\nYou are an execution-focused planning specialist. Convert goals into sequenced, verifiable work while keeping decisions, dependencies, and risk visible.\n\n## Operating process\n\n1. Confirm the outcome and non-negotiable constraints.\n2. Identify dependencies, risks, unknowns, and approval boundaries.\n3. Break the work into coherent milestones.\n4. Define acceptance checks for every milestone.\n5. Keep the plan current as new evidence appears.\n\n## Boundaries\n\nDo not treat an unresolved product decision as an implementation detail.\n\n## Output contract\n\nReturn an ordered plan with outcomes, checks, dependencies, risks, and decisions requiring approval.\n"
        ),
        _ => format!(
            "# {name}\n\nYou are a focused specialist responsible for the objective described above. Work methodically, use the assigned skills when relevant, and communicate assumptions before they affect the result.\n\n## Operating process\n\n1. Clarify the requested outcome and constraints.\n2. Inspect the available context and evidence.\n3. Apply the most relevant assigned capabilities.\n4. Verify the result in proportion to its risk.\n5. Report the outcome, limitations, and next action clearly.\n\n## Boundaries\n\nDo not expand scope, execute destructive actions, or change external state without appropriate authorization.\n\n## Output contract\n\nLead with the result. Include evidence, limitations, and next steps only where they help the user act.\n"
        ),
    }
}

fn create_agent_at(
    root: &Path,
    category: &Path,
    name: &str,
    description: &str,
    model: &str,
    tools: &[&str],
    skills: &[&str],
    template: &str,
) -> Result<AgentSummary, String> {
    let agent_root = root.join("agents");
    fs::create_dir_all(&agent_root).map_err(err)?;
    let agent_root = canonical_dir(&agent_root)?;
    let parent = agent_root.join(category);
    fs::create_dir_all(&parent).map_err(err)?;
    let parent = canonical_dir(&parent)?;
    if !parent.starts_with(&agent_root) {
        return Err("Agent category resolves outside the library".into());
    }
    let destination = parent.join(format!("{}.md", slug(name)?));
    if destination.exists() {
        return Err("An agent with that filename already exists".into());
    }
    let frontmatter = AgentFrontmatter {
        name: Some(name.into()),
        description: Some(description.into()),
        model: Some(model.into()),
        tools: tools.iter().map(|value| (*value).into()).collect(),
        skills: skills.iter().map(|value| (*value).into()).collect(),
    };
    let yaml = serde_yaml::to_string(&frontmatter)
        .map_err(|error| format!("Could not serialize agent frontmatter: {error}"))?;
    fs::write(
        &destination,
        format!(
            "---\n{yaml}---\n\n{}",
            agent_template_body(Some(template), name)
        ),
    )
    .map_err(err)?;
    Ok(inspect_agent(&agent_root, &destination))
}

#[tauri::command]
fn seed_starter_agents(root: String) -> Result<Vec<AgentSummary>, String> {
    let root = canonical_dir(Path::new(&root))?;
    let starters = [
        (
            "Code Investigator",
            "Investigates code issues, traces root causes, and recommends verified fixes. Use when a bug or unexpected behavior needs diagnosis.",
            "sonnet",
            &["Read", "Grep", "Glob"] as &[&str],
            &["Code Review"] as &[&str],
            "reviewer",
        ),
        (
            "Research Lead",
            "Researches questions with evidence, reconciles conflicting claims, and communicates confidence. Use when a decision needs reliable sources.",
            "sonnet",
            &["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as &[&str],
            &["Research Synthesizer"] as &[&str],
            "researcher",
        ),
        (
            "Delivery Planner",
            "Turns goals into a sequenced delivery plan with acceptance checks, risks, and approval points. Use before implementing substantial work.",
            "inherit",
            &["Read", "Grep", "Glob"] as &[&str],
            &["Project Planner"] as &[&str],
            "planner",
        ),
    ];
    let category = Path::new("starter-agents");
    let mut created = Vec::new();
    for (name, description, model, tools, skills, template) in starters {
        let destination = root
            .join("agents")
            .join(category)
            .join(format!("{}.md", slug(name)?));
        if !destination.exists() {
            created.push(create_agent_at(
                &root,
                category,
                name,
                description,
                model,
                tools,
                skills,
                template,
            )?);
        }
    }
    Ok(created)
}

fn authorized_agent_file(root: &Path, agent_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_dir(root)?;
    let agent_root = canonical_dir(&root.join("agents"))?;
    let file = dunce::canonicalize(agent_path).map_err(err)?;
    if !file.is_file() || !file.starts_with(&agent_root) {
        return Err("Agent path is outside the selected library".into());
    }
    Ok((agent_root, file))
}

#[tauri::command]
fn read_agent(root: String, agent_path: String) -> Result<AgentDocument, String> {
    let (agent_root, file) = authorized_agent_file(Path::new(&root), Path::new(&agent_path))?;
    let content = fs::read_to_string(&file).map_err(err)?;
    let agent = inspect_agent(&agent_root, &file);
    Ok(AgentDocument {
        name: agent.name,
        description: agent.description,
        path: agent.path,
        relative_path: agent.relative_path,
        modified: agent.modified,
        status: agent.status,
        errors: agent.errors,
        model: agent.model,
        tools: agent.tools,
        skills: agent.skills,
        fingerprint: fingerprint(&content),
        content,
    })
}

#[tauri::command]
fn save_agent(
    root: String,
    agent_path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<AgentDocument, String> {
    let (_, file) = authorized_agent_file(Path::new(&root), Path::new(&agent_path))?;
    let current = fs::read_to_string(&file).map_err(err)?;
    if fingerprint(&current) != expected_fingerprint {
        return Err("Agent changed outside the app. Reload it before saving, or explicitly resolve the conflict.".into());
    }
    let parent = file.parent().ok_or("Agent has no parent folder")?;
    let temporary = parent.join(format!(
        ".{}.command-center.tmp",
        file.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&temporary, content.as_bytes()).map_err(err)?;
    fs::rename(&temporary, &file).map_err(err)?;
    read_agent(root, agent_path)
}

#[tauri::command]
fn install_agent(
    root: String,
    agent_path: String,
    scope: String,
    project_root: Option<String>,
) -> Result<String, String> {
    let (agent_root, agent) = authorized_agent_file(Path::new(&root), Path::new(&agent_path))?;
    if inspect_agent(&agent_root, &agent).status != "valid" {
        return Err("Fix validation errors before installing".into());
    }
    let base = match scope.as_str() {
        "personal" => dirs::home_dir()
            .ok_or("Home folder is unavailable")?
            .join(".claude/agents"),
        "project" => canonical_dir(Path::new(
            project_root.as_deref().ok_or("Choose a project folder")?,
        ))?
        .join(".claude/agents"),
        _ => return Err("Unknown installation scope".into()),
    };
    fs::create_dir_all(&base).map_err(err)?;
    let filename = agent.file_name().ok_or("Agent file has no name")?;
    let destination = base.join(filename);
    if destination.exists() || destination.symlink_metadata().is_ok() {
        return Err(format!(
            "Installation target already exists: {}",
            destination.display()
        ));
    }
    fs::copy(&agent, &destination).map_err(err)?;
    if fs::read(&agent).map_err(err)? != fs::read(&destination).map_err(err)? {
        let _ = fs::remove_file(&destination);
        return Err("Could not verify installed agent copy".into());
    }
    Ok(destination.to_string_lossy().into_owned())
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("Choose a destination outside the source skill folder".into());
    }
    fs::create_dir(destination).map_err(err)?;
    let result = copy_dir_contents(source, destination);
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

fn copy_dir_contents(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
    {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Import contains a symlink and was stopped: {}",
                entry.path().display()
            ));
        }
        let target = destination.join(entry.path().strip_prefix(source).map_err(err)?);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(err)?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), target).map_err(err)?;
        } else {
            return Err(format!("Unsupported file: {}", entry.path().display()));
        }
    }
    Ok(())
}
#[tauri::command]
fn import_skill(root: String, category: String, source: String) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let category = authorized_relative_dir(&root, &safe_relative(&category)?)?;
    let source = canonical_dir(Path::new(&source))?;
    if !source.join("SKILL.md").is_file() {
        return Err("The selected folder does not contain SKILL.md".into());
    }
    let skill = inspect(&source, &source);
    if skill.status != "valid" {
        return Err(skill.errors.join("; "));
    }
    let name = source.file_name().ok_or("Selected folder has no name")?;
    let destination = category.join(name);
    if destination.exists() {
        return Err("The import destination already exists".into());
    }
    copy_dir(&source, &destination)?;
    Ok(destination.to_string_lossy().into())
}

#[tauri::command]
fn export_skill_zip(
    root: String,
    skill_path: String,
    destination_folder: String,
) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let dir = within(&root, Path::new(&skill_path))?;
    if inspect(&root, &dir).status != "valid" {
        return Err("Fix validation errors before exporting".into());
    }
    let directory = canonical_dir(Path::new(&destination_folder))?;
    if directory.starts_with(&dir) {
        return Err("Choose an export folder outside the skill package".into());
    }
    let name = dir.file_name().ok_or("Skill folder has no name")?;
    let mut filename = name.to_os_string();
    filename.push(".zip");
    let destination = directory.join(filename);
    let output = fs::File::create_new(&destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    if let Err(error) = write_skill_zip(&dir, output) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination.to_string_lossy().into_owned())
}

fn write_skill_zip(dir: &Path, output: fs::File) -> Result<(), String> {
    let mut zip = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
    {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "ZIP export does not follow symlinks: {}",
                entry.path().display()
            ));
        }
        let relative = entry
            .path()
            .strip_prefix(dir)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.file_type().is_dir() {
            zip.add_directory(format!("{relative}/"), options)
                .map_err(err)?;
        } else if entry.file_type().is_file() {
            zip.start_file(relative, options).map_err(err)?;
            let mut file = fs::File::open(entry.path()).map_err(err)?;
            std::io::copy(&mut file, &mut zip).map_err(err)?;
        } else {
            return Err(format!("Unsupported file: {}", entry.path().display()));
        }
    }
    zip.finish().map_err(err)?;
    Ok(())
}

#[cfg(unix)]
#[tauri::command]
fn install_skill(
    root: String,
    skill_path: String,
    scope: String,
    project_root: Option<String>,
) -> Result<String, String> {
    use std::os::unix::fs::symlink;
    let root = canonical_dir(Path::new(&root))?;
    let skill = within(&root, Path::new(&skill_path))?;
    if inspect(&root, &skill).status != "valid" {
        return Err("Fix validation errors before installing".into());
    }
    let base = match scope.as_str() {
        "personal" => dirs::home_dir()
            .ok_or("Home folder is unavailable")?
            .join(".claude/skills"),
        "project" => canonical_dir(Path::new(
            project_root.as_deref().ok_or("Choose a project folder")?,
        ))?
        .join(".claude/skills"),
        _ => return Err("Unknown installation scope".into()),
    };
    fs::create_dir_all(&base).map_err(err)?;
    let folder = skill.file_name().ok_or("Skill folder has no name")?;
    let destination = canonical_dir(&base)?.join(folder);
    if destination.starts_with(&skill) {
        return Err("Choose an installation folder outside the source skill".into());
    }
    if destination.exists() || destination.symlink_metadata().is_ok() {
        return Err(format!(
            "Installation target already exists: {}",
            destination.display()
        ));
    }
    symlink(&skill, &destination).map_err(err)?;
    let target = fs::read_link(&destination).map_err(err)?;
    if target != skill {
        let _ = fs::remove_file(&destination);
        return Err("Could not verify installed symlink".into());
    }
    Ok(destination.to_string_lossy().into())
}

#[cfg(windows)]
#[tauri::command]
fn install_skill(
    root: String,
    skill_path: String,
    scope: String,
    project_root: Option<String>,
) -> Result<String, String> {
    use std::os::windows::fs::symlink_dir;
    let root = canonical_dir(Path::new(&root))?;
    let skill = within(&root, Path::new(&skill_path))?;
    if inspect(&root, &skill).status != "valid" {
        return Err("Fix validation errors before installing".into());
    }
    let base = match scope.as_str() {
        "personal" => dirs::home_dir()
            .ok_or("Home folder is unavailable")?
            .join(".claude/skills"),
        "project" => canonical_dir(Path::new(
            project_root.as_deref().ok_or("Choose a project folder")?,
        ))?
        .join(".claude/skills"),
        _ => return Err("Unknown installation scope".into()),
    };
    fs::create_dir_all(&base).map_err(err)?;
    let folder = skill.file_name().ok_or("Skill folder has no name")?;
    let destination = canonical_dir(&base)?.join(folder);
    if destination.starts_with(&skill) {
        return Err("Choose an installation folder outside the source skill".into());
    }
    if destination.exists() || destination.symlink_metadata().is_ok() {
        return Err(format!(
            "Installation target already exists: {}",
            destination.display()
        ));
    }
    if let Err(error) = symlink_dir(&skill, &destination) {
        if matches!(error.raw_os_error(), Some(5 | 50 | 1314)) {
            copy_dir(&skill, &destination)?;
            return Ok(destination.to_string_lossy().into());
        }
        return Err(format!("Could not install the skill: {error}"));
    }
    if !dunce::canonicalize(&destination).is_ok_and(|target| target == skill) {
        let _ = fs::remove_dir(&destination);
        return Err("Could not verify installed Windows skill link".into());
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("Path is unavailable".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&path);
        c
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(if path.is_dir() {
            &path
        } else {
            path.parent().unwrap_or(&path)
        });
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", path.display()));
        c
    };
    command.spawn().map_err(err)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(activity::ActivityLedger::default())
        .invoke_handler(tauri::generate_handler![
            activity::activity_snapshot,
            knowledge::search_knowledge,
            knowledge::answer_from_sources,
            skill_runs::run_test,
            skill_runs::list_runs,
            skill_runs::evaluate_run,
            skill_runs::get_run_baseline,
            skill_runs::set_run_baseline,
            workflows::run_proposal,
            workflows::list_proposals,
            workflows::list_proposal_recipes,
            workflows::save_proposal_recipe,
            scan_library,
            read_skill,
            save_skill,
            create_category,
            create_agent_category,
            create_skill,
            seed_starter_skills,
            seed_starter_agents,
            agent_creator::preview_agent,
            agent_creator::create_agent,
            read_agent,
            save_agent,
            install_agent,
            import_skill,
            export_skill_zip,
            install_skill,
            reveal_in_file_manager
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Command Center");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_paths() {
        assert!(safe_relative("../outside").is_err());
        assert!(safe_relative("good/category").is_ok());
    }
    #[test]
    fn validates_frontmatter() {
        assert!(split_frontmatter("---\nname: demo\ndescription: useful\n---\nBody").is_ok());
        assert!(split_frontmatter("No frontmatter").is_err());
    }
    #[test]
    fn skill_can_be_imported_exported_and_installed() {
        let scratch = std::env::temp_dir().join(format!(
            "command-center-workflow-{}-{}",
            std::process::id(),
            UNIX_EPOCH.elapsed().unwrap().as_nanos()
        ));
        fs::create_dir(&scratch).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(scratch.clone());
        let library = scratch.join("Library");
        let project = scratch.join("Project with spaces");
        let source = scratch.join("review-skill");
        for folder in [&library, &project, &source] {
            fs::create_dir(folder).unwrap();
        }
        let text_path = |path: &Path| path.to_string_lossy().into_owned();
        let contents =
            "---\nname: review-skill\ndescription: Reviews a draft.\n---\nReview the draft.";
        fs::write(source.join("SKILL.md"), contents).unwrap();
        fs::write(source.join("notes.md"), "Supporting notes").unwrap();
        let root = text_path(&library);
        let imported = import_skill(root.clone(), String::new(), text_path(&source)).unwrap();
        assert!(export_skill_zip(root.clone(), imported.clone(), imported.clone()).is_err());
        let archive =
            export_skill_zip(root.clone(), imported.clone(), text_path(&project)).unwrap();
        {
            let mut zip = zip::ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
            assert!(zip.by_name("SKILL.md").is_ok());
            assert!(zip.by_name("notes.md").is_ok());
        }
        assert!(export_skill_zip(root.clone(), imported.clone(), text_path(&project)).is_err());
        let installed =
            install_skill(root, imported, "project".into(), Some(text_path(&project))).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&installed).join("SKILL.md")).unwrap(),
            contents
        );
        assert!(
            project
                .join(".claude/skills/review-skill/notes.md")
                .is_file()
        );
    }
    #[test]
    fn protects_reserved_slugs() {
        assert!(slug("Synced").is_err());
        assert_eq!(slug("My Useful Skill").unwrap(), "my-useful-skill");
    }
    #[test]
    fn parses_agent_frontmatter_lists() {
        let parsed = split_agent_frontmatter(
            "---\nname: reviewer\ndescription: 'Review: code safely'\nmodel: sonnet\ntools:\n  - Read\n  - Grep\nskills:\n  - code-review\n---\nBody",
        )
        .unwrap();
        assert_eq!(parsed.name.as_deref(), Some("reviewer"));
        assert_eq!(parsed.tools, vec!["Read", "Grep"]);
        assert_eq!(parsed.skills, vec!["code-review"]);
    }
    #[test]
    fn validates_agent_models() {
        assert!(valid_agent_model("inherit"));
        assert!(valid_agent_model("claude-sonnet-4-5-20250929"));
        assert!(!valid_agent_model("fastest"));
    }
    #[test]
    fn serializes_yaml_sensitive_skill_metadata() {
        let frontmatter = Frontmatter {
            name: Some("Review: API #1".into()),
            description: Some("Checks: safety and 'correctness'".into()),
        };
        let yaml = serde_yaml::to_string(&frontmatter).unwrap();
        let parsed: Frontmatter = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Review: API #1"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("Checks: safety and 'correctness'")
        );
    }
}
