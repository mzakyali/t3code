// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const vpExecutable = process.platform === "win32" ? "vp.cmd" : "vp";
const args = ["test", "run", "apps/server/src/provider/acp/DevinAcpCliProbe.test.ts"];
const command = [vpExecutable, ...args].join(" ");

const result = NodeChildProcess.spawnSync(vpExecutable, args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    T3_DEVIN_ACP_PROBE: "0",
    T3_DEVIN_MCP_SMOKE: "1",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`${command}: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
