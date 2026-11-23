# AI Command Center

A local-first macOS-oriented studio for creating, organizing, validating, and publishing portable AI skills and Claude Code agents. The filesystem is the source of truth: every capability remains an ordinary folder or Markdown file visible in Finder.

## Development

Requirements: Node.js 20+, Rust stable, and the platform dependencies required by Tauri 2.

```sh
npm install
npm run tauri dev
```

Useful checks:

```sh
npm run build
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

### Windows prerequisites

Install Git, Node.js LTS, Rust with the MSVC toolchain, Microsoft C++ Build Tools (`Desktop development with C++`), and WebView2. Windows 10 version 1803+ and Windows 11 normally include WebView2. Enable Windows Developer Mode if you want Command Center to install skills as filesystem links without running as administrator.

## Current capabilities

- Choose one local library root and browse its physical folder hierarchy.
- Create category folders and valid `SKILL.md` packages.
- Import complete skill folders without altering their source.
- Create Claude Code agents with a model preference, tool allowlist, role template, and preloaded library skills.
- Switch between Skills and Agents studios with physical categories for each.
- Search, inspect, edit, explicitly save, and validate canonical Markdown source.
- Run provider-free quality checks for activation conditions, process, constraints, output contracts, placeholders, and Claude compatibility.
- Detect save conflicts using content fingerprints.
- Export a portable ZIP to a selected folder. Install skills in personal or project Claude Code locations. If Windows denies link creation, the app installs a copy.
- Install agents as verified Markdown copies to personal or project Claude Code locations.
- Search a local document folder and generate cited answers with Ollama in Knowledge.

Local Claude Code installation does not imply that a running session has loaded a capability. ZIP export requires manual upload for account-level Claude access. See [Capability Studio architecture](docs/CAPABILITY_STUDIO.md) for the product model and future extension seams.

## Try Knowledge

1. Open **Knowledge** and enter the full path of a folder with Markdown or plain-text documents.
2. Enter a question and select **Find sources**. Review the matching excerpts and their file and line references.
3. For generation, start Ollama and download a model, for example `ollama pull gemma3:4b`. Enter the model's exact name, optionally choose a saved skill from your library, then select **Generate answer**.

Retrieval uses keywords and reads the current files on each search. Generation sends the selected excerpts to Ollama at `127.0.0.1:11434`. To enforce local-only operation in Ollama, set `OLLAMA_NO_CLOUD=1` in its environment and restart Ollama.
