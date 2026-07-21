---
name: GitHub-imported artifact re-registration
description: What to do when a repo imported from GitHub has artifact.toml files on disk but listArtifacts() is empty and no workflows exist.
---

- Artifact registration state (what `listArtifacts()` and managed `artifacts/<slug>: <service>` workflows know about) is not stored in git — only the `.replit-artifact/artifact.toml` files are. After a plain GitHub import/re-import, the TOML files can be present and correct while the runtime has no matching artifact or workflow at all.
- Do NOT "fix" this by moving the artifact directory aside and re-running `createArtifact` — that re-bootstraps/scaffolds fresh files and risks clobbering real, working application code that happens to live in that same directory.
- Working stand-in: read the service's `run` command, `localPort`, and env from `artifact.toml` and configure a plain workflow with `configureWorkflow` (e.g. `PORT=8080 pnpm --filter @workspace/api-server run dev`, `waitForPort` matching `localPort`). This isn't the managed artifact-workflow path, but it gets the service running without touching source files.
- Remember to also run `pnpm install` (node_modules is never in git) and push any DB schema (`drizzle-kit push`) before the first start — a freshly imported project usually fails on both until that's done.
