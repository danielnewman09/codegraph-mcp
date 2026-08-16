/**
 * Host-neutral file-opening helper.
 *
 * Opens a path with the platform default viewer (macOS `open`, Windows
 * `start`, Linux `xdg-open`).  No GUI is assumed by the caller — the
 * harness decides whether to call this at all (MCP harness never does).
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";

export async function openPath(target: string): Promise<void> {
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === "darwin") { cmd = "open"; args = [target]; }
  else if (os === "win32") { cmd = "cmd"; args = ["/c", "start", "", target]; }
  else { cmd = "xdg-open"; args = [target]; }

  await new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || `Failed to open ${target} (${err.message})`));
      } else {
        resolve();
      }
    });
  });
}
