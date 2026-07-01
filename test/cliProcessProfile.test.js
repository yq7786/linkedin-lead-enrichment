import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("process-profile command requires --profile-url", async () => {
  const result = await runCli(["process-profile"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--profile-url is required/);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
