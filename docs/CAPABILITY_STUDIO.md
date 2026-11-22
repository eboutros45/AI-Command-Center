# Capability Studio architecture

AI Command Center is a filesystem-first studio for reusable AI capabilities. Skills and agents are the current first-class asset types. Knowledge sources, retrieval, embeddings, runtimes, and provider integrations are future adapters—not requirements of the core library.

## Product principles

1. **Files are canonical.** The interface reflects ordinary folders and Markdown; it does not maintain a competing content database.
2. **Authoring and installation are separate.** A library asset may be valid without being installed, and installation never changes the canonical source.
3. **Portable source, explicit adapters.** Skills follow the Agent Skills format. Agents remain readable Markdown and are adapted to each consumer's supported location and metadata.
4. **No hidden execution.** Indexing, validation, import, and preview never run scripts from a package.
5. **Deterministic before generative.** Templates, validation, and structured builders work without an API key. AI-assisted generation can be added later as an optional provider.
6. **Future knowledge stays decoupled.** Assets may eventually reference stable knowledge-source IDs. Indexes and embeddings belong to replaceable providers rather than skill or agent source files.

## Library layout

Existing skill libraries remain supported: a skill is any directory under the selected root containing `SKILL.md`.

Agents use a dedicated physical subtree so Markdown references inside skill packages are not mistaken for agents:

```text
Library Root/
├── Development/
│   └── code-review/
│       ├── SKILL.md
│       └── references/
├── Research/
│   └── source-verification/
│       └── SKILL.md
└── agents/
    ├── Development/
    │   └── code-improver.md
    └── Research/
        └── research-lead.md
```

Agent categories are real subdirectories. Each agent is an individual Markdown file compatible with Claude Code's agent representation after validation and installation.

## Studio surfaces

- **Overview / Builder:** human-friendly metadata and capability configuration.
- **Source:** canonical Markdown with explicit save and conflict protection.
- **Files:** skill resources and references. Agent resources can be added when a consumer format supports them.
- **Test:** deterministic validation and example activation scenarios; provider-backed evaluation is optional future work.
- **Publish:** verified personal/project installations, exports, and safe removal.

## Future extension seams

- `KnowledgeProvider`: lists and resolves knowledge collections.
- `EmbeddingProvider`: indexes content without changing canonical packages.
- `ModelProvider`: optional generation and evaluation.
- `RuntimeAdapter`: installs or translates assets for Claude Code, Codex, and other consumers.
- `InstallationRegistry`: records only app-managed destinations and fingerprints.

These interfaces should be introduced when a real feature needs them. The current release must not require a vector database, hosted service, account, or API key.
