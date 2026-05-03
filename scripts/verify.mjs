import { spawn, spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageJupyterLab } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const serviceVersion = process.env.JUPYTERLAB_SERVICE_VERSION ?? "1.0.0";
const pythonVersion = "3.11.5";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.error?.message ?? ""}`);
  }
}

function extractArchive(archivePath, targetPath) {
  if (archivePath.endsWith(".zip")) {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(targetPath, true);
    return;
  }

  run("tar", ["-xf", archivePath, "-C", targetPath]);
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, expectedStatus = 200, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) {
        return response;
      }
      lastError = new Error(`Expected ${expectedStatus} from ${url}, got ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function latestReleaseAsset(repo, assetName) {
  const headers = { "User-Agent": "lasso-jupyterlab-verify" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to read latest release for ${repo}: ${response.status} ${await response.text()}`);
  }
  const release = await response.json();
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(`Release ${repo}@${release.tag_name} does not contain ${assetName}`);
  }
  return asset.browser_download_url;
}

async function downloadFile(url, target) {
  const headers = { "User-Agent": "lasso-jupyterlab-verify" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${await response.text()}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

const artifact = await packageJupyterLab(platform, serviceVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", serviceVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const pythonRoot = path.join(verifyRoot, "python");
const pythonAssetName = `lasso-python-${pythonVersion}-win32.zip`;
const pythonArchive = path.join(verifyRoot, "downloads", pythonAssetName);
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const port = await reserveLoopbackPort();

if (platform !== "win32") {
  throw new Error("lasso-jupyterlab currently supports win32 only because @python publishes win32 artifacts only.");
}

if (serviceManifest.id !== "jupyterlab" || serviceManifest.version !== serviceVersion) {
  throw new Error(`Unexpected manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}
if (!serviceManifest.depend_on?.includes("@python") || serviceManifest.depend_on.includes("@node")) {
  throw new Error("JupyterLab manifest must depend on @python only; JavaScript kernels are not shipped.");
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await mkdir(pythonRoot, { recursive: true });
extractArchive(artifact, extractRoot);
const pythonUrl = await latestReleaseAsset("service-lasso/lasso-python", pythonAssetName);
await downloadFile(pythonUrl, pythonArchive);
extractArchive(pythonArchive, pythonRoot);

const packageMetadata = JSON.parse(await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"));
if (packageMetadata.serviceId !== "jupyterlab" || packageMetadata.version !== serviceVersion || packageMetadata.platform !== platform) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const python = path.join(pythonRoot, "python.exe");
const jupyterDataDir = path.join(serviceRoot, "data");
const jupyterConfigDir = path.join(serviceRoot, "config");
const jupyterRuntimeDir = path.join(serviceRoot, "runtime");
const jupyterEnv = {
  ...process.env,
  SERVICE_ROOT: serviceRoot,
  SERVICE_PORT: String(port),
  JUPYTERLAB_HOST: "127.0.0.1",
  JUPYTERLAB_PORT: String(port),
  SERVICE_DATA_PATH: path.join(serviceRoot, "notebooks"),
  JUPYTER_DATA_DIR: jupyterDataDir,
  JUPYTER_CONFIG_DIR: jupyterConfigDir,
  JUPYTER_RUNTIME_DIR: jupyterRuntimeDir,
  JUPYTERLAB_WORKSPACES_DIR: path.join(serviceRoot, "workspaces"),
  PYTHONPATH: path.join(extractRoot, "python-packages"),
};
const child = spawn(python, ["./lasso-jupyterlab.py"], {
  cwd: extractRoot,
  env: jupyterEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const response = await waitForHttp(`http://127.0.0.1:${port}/api`);
  const body = await response.json();
  if (!body.version) {
    throw new Error(`Unexpected Jupyter API response: ${JSON.stringify(body)}`);
  }

  const kernelspecResponse = await waitForHttp(`http://127.0.0.1:${port}/api/kernelspecs`);
  const kernelspecs = await kernelspecResponse.json();
  if (kernelspecs.kernelspecs?.javascript) {
    throw new Error(`JupyterLab unexpectedly exposed an unsupported JavaScript kernelspec: ${JSON.stringify(kernelspecs.kernelspecs.javascript)}`);
  }

  const stop = spawnSync(python, ["./lasso-jupyterlab-stop.py"], {
    cwd: extractRoot,
    env: jupyterEnv,
    stdio: "inherit",
    windowsHide: true,
  });
  if (stop.status !== 0) {
    throw new Error(`Stop action failed with exit code ${stop.status}`);
  }

  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(20_000).then(() => {
      throw new Error("JupyterLab did not exit after stop action.");
    }),
  ]);

  console.log(`[lasso-jupyterlab] verified package, @python execution, no unsupported JavaScript kernel, health, and stop on port ${port}`);
} catch (error) {
  console.error("[lasso-jupyterlab] stdout:");
  console.error(stdout);
  console.error("[lasso-jupyterlab] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
