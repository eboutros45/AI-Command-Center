# AI Command Center

A local-first macOS-oriented library for creating, organizing, validating, and publishing portable AI skills. The filesystem is the source of truth: every category and skill remains an ordinary folder visible in Finder.

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

## Current capabilities

- Choose one local library root and browse its physical folder hierarchy.
- Create category folders and valid `SKILL.md` packages.
- Import complete skill folders without altering their source.
- Search, edit, explicitly save, and validate skills.
- Detect save conflicts using content fingerprints.
- Export portable ZIPs and install verified Claude Code symlinks to personal or project skill locations.

Local Claude Code installation does not imply that a running session has loaded a skill. ZIP export requires manual upload for account-level Claude access.
