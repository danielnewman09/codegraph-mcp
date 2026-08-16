# Codex integration

This directory is the Codex-only plugin package. It contains the plugin
manifest, MCP server declaration, Codex skill, and a built, self-contained
stdio MCP server plus Python bridge. Run `npm run build` at the repository
root before installing or updating the plugin. The source harness consumes
the shared runtime in `../../src/core` and never imports the Pi extension.
