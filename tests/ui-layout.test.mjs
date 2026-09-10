import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const chromePath = process.env.SPEAKIT_TEST_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out starting the UI test server")), 10_000);
    const ready = (chunk) => {
      if (!chunk.toString().includes("Local:")) return;
      clearTimeout(timeout);
      resolve();
    };
    server.stdout.on("data", ready);
    server.stderr.on("data", ready);
    server.once("error", reject);
  });
}

function waitForDevtools(browser) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out launching the layout browser. ${output}`)), 10_000);
    browser.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    browser.once("error", reject);
  });
}

async function pageDebuggerUrl(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    const page = pages.find((target) => target.type === "page");
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Chrome did not expose a page for layout testing");
}

async function connectDebugger(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    call(method, params = {}) {
      requestId += 1;
      const id = requestId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => socket.close(),
  };
}

async function readLayout(debuggerClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await debuggerClient.call("Runtime.evaluate", {
      expression: `({
        ready: document.body?.dataset.historyCount === "5",
        recentBelowDiagnostics: document.body?.dataset.recentBelowDiagnostics,
        homeFitsViewport: document.body?.dataset.homeFitsViewport,
        capturesFitCard: document.body?.dataset.capturesFitCard,
        horizontalOverflow: document.body?.dataset.horizontalOverflow,
        historyCount: document.body?.dataset.historyCount,
        recentVisibleCount: document.body?.dataset.recentVisibleCount
      })`,
      returnByValue: true,
    });
    if (response.result.value?.ready) return response.result.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The UI preview did not finish rendering layout measurements");
}

async function readDictationPipeline(debuggerClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await debuggerClient.call("Runtime.evaluate", {
      expression: `({
        ready: document.body?.dataset.pipelineReady === "true",
        secondStartedBeforeFirstFinished: document.body?.dataset.secondStartedBeforeFirstFinished,
        originalTargetPreserved: document.body?.dataset.originalTargetPreserved
      })`,
      returnByValue: true,
    });
    if (response.result.value?.ready) return response.result.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The rapid-repeat dictation regression did not finish");
}

async function readAudioRecovery(debuggerClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await debuggerClient.call("Runtime.evaluate", {
      expression: `({
        ready: document.body?.dataset.audioRecoveryReady === "true",
        firstTimedOut: document.body?.dataset.firstTimedOut,
        pendingRequestReused: document.body?.dataset.pendingRequestReused,
        lateStreamRetained: document.body?.dataset.lateStreamRetained
      })`,
      returnByValue: true,
    });
    if (response.result.value?.ready) return response.result.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The delayed microphone recovery regression did not finish");
}

test("real browser regressions cover the home layout and rapid-repeat dictation", { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "speakit-layout-"));
  const server = spawn(path.join(projectRoot, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", "4178", "--strictPort"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  let debuggerClient;
  try {
    await waitForServer(server);
    browser = spawn(chromePath, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const port = await waitForDevtools(browser);
    debuggerClient = await connectDebugger(await pageDebuggerUrl(port));
    await debuggerClient.call("Emulation.setDeviceMetricsOverride", {
      width: 532,
      height: 616,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await debuggerClient.call("Page.navigate", { url: "http://127.0.0.1:4178/tests/ui-preview.html" });
    const layout = await readLayout(debuggerClient);
    assert.deepEqual(layout, {
      ready: true,
      recentBelowDiagnostics: "true",
      homeFitsViewport: "true",
      capturesFitCard: "true",
      horizontalOverflow: "false",
      historyCount: "5",
      recentVisibleCount: "1",
    });
    await debuggerClient.call("Page.navigate", { url: "http://127.0.0.1:4178/tests/dictation-pipeline.html" });
    const pipeline = await readDictationPipeline(debuggerClient);
    assert.deepEqual(pipeline, {
      ready: true,
      secondStartedBeforeFirstFinished: "true",
      originalTargetPreserved: "true",
    });
    await debuggerClient.call("Page.navigate", { url: "http://127.0.0.1:4178/tests/audio-recovery.html" });
    const audioRecovery = await readAudioRecovery(debuggerClient);
    assert.deepEqual(audioRecovery, {
      ready: true,
      firstTimedOut: "true",
      pendingRequestReused: "true",
      lateStreamRetained: "true",
    });
  } finally {
    debuggerClient?.close();
    if (browser?.exitCode === null) browser.kill("SIGKILL");
    server.kill("SIGTERM");
    await rm(profile, { recursive: true, force: true });
  }
});
