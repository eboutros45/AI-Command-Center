use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

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
struct Library {
    root: String,
    categories: Vec<Category>,
    skills: Vec<Skill>,
}
#[derive(Default, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("Folder is unavailable: {}", path.display()));
    }
    path.canonicalize().map_err(err)
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
    let candidate = candidate.canonicalize().map_err(err)?;
    if !candidate.starts_with(&root) {
        return Err("Path is outside the selected library".into());
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
    if !content.starts_with("---\n") {
        return Err("SKILL.md must begin with YAML frontmatter".into());
    }
    let rest = &content[4..];
    let end = rest.find("\n---").ok_or("Frontmatter has no closing ---")?;
    serde_yaml::from_str(&rest[..end]).map_err(|error| format!("Invalid YAML frontmatter: {error}"))
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
            if !path.is_dir()
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
    Ok(Library {
        root: root.to_string_lossy().into(),
        categories: category_tree(&root, &skill_dirs),
        skills,
    })
}

#[tauri::command]
fn read_skill(root: String, skill_path: String) -> Result<SkillDocument, String> {
    let root = canonical_dir(Path::new(&root))?;
    let dir = within(&root, Path::new(&skill_path))?;
    let content = fs::read_to_string(dir.join("SKILL.md")).map_err(err)?;
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
    let name = slug(&name)?;
    let destination = root.join(parent).join(name);
    if destination.exists() {
        return Err("A folder with that name already exists".into());
    }
    fs::create_dir(&destination).map_err(err)?;
    Ok(destination.to_string_lossy().into())
}

#[tauri::command]
fn create_skill(
    root: String,
    category: String,
    name: String,
    description: String,
) -> Result<Skill, String> {
    let root = canonical_dir(Path::new(&root))?;
    let category = safe_relative(&category)?;
    let folder = slug(&name)?;
    let destination = root.join(category).join(&folder);
    if destination.exists() {
        return Err("A skill with that folder name already exists".into());
    }
    fs::create_dir(&destination).map_err(err)?;
    let safe_name = name.replace(['\n', '\r'], " ");
    let safe_description = description.replace(['\n', '\r'], " ");
    fs::write(destination.join("SKILL.md"), format!("---\nname: {}\ndescription: {}\n---\n\n# {}\n\nDescribe when and how Claude should use this skill.\n", safe_name, safe_description, safe_name)).map_err(err)?;
    Ok(inspect(&root, &destination))
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(err)?;
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
        } else {
            fs::copy(entry.path(), target).map_err(err)?;
        }
    }
    Ok(())
}
#[tauri::command]
fn import_skill(root: String, category: String, source: String) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let category = safe_relative(&category)?;
    let source = canonical_dir(Path::new(&source))?;
    if !source.join("SKILL.md").is_file() {
        return Err("The selected folder does not contain SKILL.md".into());
    }
    let name = source.file_name().ok_or("Selected folder has no name")?;
    let destination = root.join(category).join(name);
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
    destination: String,
) -> Result<String, String> {
    let root = canonical_dir(Path::new(&root))?;
    let dir = within(&root, Path::new(&skill_path))?;
    if inspect(&root, &dir).status != "valid" {
        return Err("Fix validation errors before exporting".into());
    }
    let output = fs::File::create(&destination).map_err(err)?;
    let mut zip = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in WalkDir::new(&dir)
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
            .strip_prefix(&dir)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.file_type().is_dir() {
            zip.add_directory(format!("{relative}/"), options)
                .map_err(err)?;
        } else {
            zip.start_file(relative, options).map_err(err)?;
            let mut file = fs::File::open(entry.path()).map_err(err)?;
            let mut data = vec![];
            file.read_to_end(&mut data).map_err(err)?;
            zip.write_all(&data).map_err(err)?;
        }
    }
    zip.finish().map_err(err)?;
    Ok(destination)
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
    let destination = base.join(folder);
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            read_skill,
            save_skill,
            create_category,
            create_skill,
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
    fn protects_reserved_slugs() {
        assert!(slug("Synced").is_err());
        assert_eq!(slug("My Useful Skill").unwrap(), "my-useful-skill");
    }
}
