# Pi integration

This directory contains the Pi-specific extension entry point and compatibility
facade. It registers Pi flags, slash commands, lifecycle hooks, and Pi tool
adaptors. It consumes the shared runtime in `../../src/core` and the canonical
tool definitions in `../../tools`; it does not depend on the Codex plugin
package.
