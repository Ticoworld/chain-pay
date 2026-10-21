import { spawn } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const composeFile = resolve(root, "tests/accounting-acceptance/compose.yml");
const project = "chainpay-accounting-" + randomBytes(6).toString("hex");
const artifacts = resolve(root, ".cache/accounting-acceptance", project);
const compose = ["compose", "--project-name", project, "--env-file", resolve(artifacts, "empty.env"), "-f", composeFile];
let activeChild;
let interrupted = false;
const stages = [];
let failedStage;

function execute(args, { log, input, capture = false, cleanup = false, timeoutMs = 15 * 60_000 } = {}) {
  if (interrupted && !cleanup) return Promise.reject(new Error("Interrupted"));
  return new Promise((resolveResult, reject) => {
    const child = spawn("docker", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    activeChild = child;
    const output = [];
    const stream = log ? createWriteStream(resolve(artifacts, log)) : undefined;
    stream?.on("error", (error) => { child.kill("SIGTERM"); reject(error); });
    for (const channel of [child.stdout, child.stderr]) channel.on("data", (bytes) => {
      if (capture && channel === child.stdout) output.push(bytes);
      else if (stream) stream.write(bytes);
      else process.stdout.write(bytes);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      activeChild = undefined;
      const finish = () => {
        if (timedOut) reject(new Error("Docker command exceeded " + timeoutMs / 1000 + "s." + (log ? " See " + log : "")));
        else if (code === 0) resolveResult(Buffer.concat(output));
        else reject(new Error("Docker command failed (exit " + code + ")." + (log ? " See " + log : "")));
      };
      if (stream) stream.end(finish);
      else finish();
    });
  });
}
const dc = async (args, options) => {
  const started = performance.now();
  if (options?.log) console.log("[accounting acceptance] " + options.log);
  let passed = false;
  try {
    const result = await execute([...compose, ...args], options);
    passed = true;
    return result;
  } catch (error) {
    if (!options?.cleanup) failedStage ??= options?.log ?? args[0];
    throw error;
  } finally {
    if (options?.log) {
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      stages.push({ stage: options.log, passed, seconds });
      console.log("[accounting acceptance] " + options.log + ": " + (passed ? "passed" : "FAILED") + " (" + seconds + "s)");
    }
  }
};

async function transferFixtures() {
  for (const name of ["accounting.json", "unprivileged.json", "date"]) {
    const content = await dc(["exec", "-T", "backend", "cat", "/tmp/acceptance-" + name], { capture: true });
    await dc(["exec", "-T", "node", "sh", "-c", "umask 077; cat > /tmp/acceptance-" + name], { input: content });
  }
}

async function collectArtifacts(prefix) {
  console.log("[accounting acceptance] " + prefix + " database audit and reports");
  const audit = await dc(["exec", "-T", "backend", "bash", "-lc",
    "cd /home/frappe/frappe-bench/sites && ../env/bin/python /acceptance/audit.py"], { capture: true });
  await writeFile(resolve(artifacts, prefix + "-database.json"), audit);
  for (const name of ["summary.json", "report.csv", "report.pdf"]) {
    await dc(["cp", "node:/tmp/acceptance-" + name, resolve(artifacts, prefix + "-" + name)]);
  }
}

async function rehearse() {
  await dc(["up", "-d", "node"], { log: "dependencies-startup.log" });
  await dc(["exec", "-T", "node", "bash", "/source/tests/accounting-acceptance/run-node.sh", "install"], { log: "install.log", timeoutMs: 30 * 60_000 });
  await dc(["up", "-d", "--wait", "--wait-timeout", "180"], { log: "startup.log" });
  await dc(["exec", "-T", "backend", "bash", "/acceptance/setup.sh"], { log: "setup.log" });
  await dc(["exec", "-d", "backend", "bash", "-lc",
    "cd /home/frappe/frappe-bench && bench serve --port 8000 --noreload > /tmp/acceptance-http.log 2>&1"]);
  await dc(["exec", "-T", "backend", "bash", "-lc",
    "cd /home/frappe/frappe-bench && ./env/bin/python /acceptance/wait-http.py"], { log: "readiness.log" });
  await transferFixtures();
  await dc(["exec", "-T", "node", "bash", "/source/tests/accounting-acceptance/run-node.sh"], { log: "first-run.log" });
  await collectArtifacts("first");
  await dc(["exec", "-T", "node", "bash", "/source/tests/accounting-acceptance/run-node.sh", "replay"], { log: "replay.log" });
  await collectArtifacts("replay");
  await compareReplays();
}

async function compareReplays() {
  const readJson = async (name) => JSON.parse(await readFile(resolve(artifacts, name), "utf8"));
  const first = await readJson("first-summary.json");
  const replay = await readJson("replay-summary.json");
  for (const name of ["payroll", "send", "lostReply"]) {
    deepStrictEqual(replay.identities[name], first.identities[name], name + " identities changed across processes");
  }
  deepStrictEqual(await readJson("first-database.json"), await readJson("replay-database.json"));
  deepStrictEqual(first.identities.export.csvSha256, replay.identities.export.csvSha256);
  await writeFile(resolve(artifacts, "verification.json"), JSON.stringify({ passed: true, separateProcessReplay: true }, null, 2));
}

async function main() {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log(`Usage: npm run test:accounting:acceptance
Requires Node 22.12+, npm 10+ and the docker compose plugin (Linux containers).
Creates a fresh disposable ERPNext site, installs locked Node dependencies, runs twice, then removes its containers and volumes.
Sanitized artifacts: .cache/accounting-acceptance/<project>/
No host ports or existing backend configuration are used.`);
      return;
    }
    throw new Error("Unknown arguments. Use --help.");
  }
  await mkdir(artifacts, { recursive: true });
  await writeFile(resolve(artifacts, "empty.env"), "");
  await writeFile(resolve(artifacts, "run.json"), JSON.stringify({ project, startedAt: new Date().toISOString() }, null, 2));
  console.log("Accounting acceptance project: " + project);
  console.log("Artifacts: " + artifacts);
  console.log("Emergency cleanup: docker compose -p " + project + " -f tests/accounting-acceptance/compose.yml down --volumes --remove-orphans");
  try {
    await rehearse();
    console.log("Accounting acceptance and separate-process replay passed.");
  } catch (error) {
    failedStage ??= "replay comparison";
    await dc(["ps", "--all"], { log: "failure-status.log", cleanup: true }).catch(() => undefined);
    await dc(["cp", "node:/tmp/acceptance-summary.json", resolve(artifacts, "failure-summary.json")],
      { log: "failure-artifacts.log", cleanup: true }).catch(() => undefined);
    await dc(["exec", "-T", "backend", "python", "/acceptance/http-diagnostics.py"],
      { log: "failure-http.log", cleanup: true, timeoutMs: 15_000 }).catch(() => undefined);
    throw error;
  } finally {
    await dc(["down", "--volumes", "--remove-orphans", "--timeout", "5"], { log: "cleanup.log", cleanup: true, timeoutMs: 60_000 })
      .catch((error) => { console.error("Cleanup failed: " + error.message + " Use the printed emergency cleanup command."); process.exitCode = 1; });
    const summary = { project, passed: !failedStage && !process.exitCode, failedStage, stages };
    await writeFile(resolve(artifacts, "stages.json"), JSON.stringify(summary, null, 2));
    if (failedStage) console.error("Failed stage: " + failedStage + ". Diagnostics: " + artifacts);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  activeChild?.kill("SIGTERM");
});
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
