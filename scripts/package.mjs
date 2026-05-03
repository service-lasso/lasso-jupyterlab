import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceVersion = process.env.JUPYTERLAB_SERVICE_VERSION ?? "1.0.0";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;
const targetPython = process.env.TARGET_PYTHON_VERSION ?? "3.11";

const targets = {
  win32: {
    archiveType: "zip",
    python: process.env.PYTHON ?? "python",
    pipPlatform: "win_amd64",
    implementation: "cp",
    abi: "cp311",
  },
};

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

function runPowershell(command) {
  run("powershell", ["-NoLogo", "-NoProfile", "-Command", command]);
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-jupyterlab-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    runPowershell(`Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

function pipInstallForTarget(target, requirementsPath, packagesRoot) {
  const downloadRoot = path.join(path.dirname(packagesRoot), "wheels");
  run(target.python, [
    "-m",
    "pip",
    "download",
    "--dest",
    downloadRoot,
    "--only-binary=:all:",
    "--platform",
    target.pipPlatform,
    "--python-version",
    targetPython,
    "--implementation",
    target.implementation,
    "--abi",
    target.abi,
    "-r",
    requirementsPath,
  ]);
  run(target.python, [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--find-links",
    downloadRoot,
    "--target",
    packagesRoot,
    "--only-binary=:all:",
    "--platform",
    target.pipPlatform,
    "--python-version",
    targetPython,
    "--implementation",
    target.implementation,
    "--abi",
    target.abi,
    "-r",
    requirementsPath,
  ]);
}

export async function packageJupyterLab(platform = targetPlatform, version = serviceVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const packagesRoot = path.join(packageRoot, "python-packages");
  const appRoot = path.join(packageRoot, "app");
  const outputPath = path.join(repoRoot, "dist", versionedAssetName(version, platform, target.archiveType));

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await cp(path.join(repoRoot, "app"), appRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });

  pipInstallForTarget(target, path.join(appRoot, "requirements.txt"), packagesRoot);

  await writeFile(path.join(packageRoot, "lasso-jupyterlab.py"), launcherSource, "utf8");
  await writeFile(path.join(packageRoot, "lasso-jupyterlab-stop.py"), stopSource, "utf8");
  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "jupyterlab",
        version,
        upstream: {
          source: "Service Lasso JupyterLab package",
          python: targetPython,
          javascriptKernel: "not shipped; IJavascript is not compatible with the current @node provider without native build tooling",
        },
        packagedBy: "service-lasso/lasso-jupyterlab",
        platform,
        arch: "x64",
        command: "python ./lasso-jupyterlab.py",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, "lasso-jupyterlab.py"), 0o755);
    await chmod(path.join(packageRoot, "lasso-jupyterlab-stop.py"), 0o755);
  }

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-jupyterlab] packaged ${outputPath}`);
  return outputPath;
}

const launcherSource = String.raw`import os
import sys
from pathlib import Path

package_root = Path(__file__).resolve().parent
app_root = package_root / "app"
packages_root = package_root / "python-packages"
service_root = Path(os.environ.get("SERVICE_ROOT", os.getcwd())).resolve()

sys.path.insert(0, str(packages_root))
existing_pythonpath = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = os.pathsep.join([str(packages_root), existing_pythonpath])
os.environ.setdefault("JUPYTER_PLATFORM_DIRS", "1")
os.environ.setdefault("JUPYTER_DATA_DIR", str(service_root / "data"))
os.environ.setdefault("JUPYTER_CONFIG_DIR", str(service_root / "config"))
os.environ.setdefault("JUPYTER_RUNTIME_DIR", str(service_root / "runtime"))
os.environ.setdefault("JUPYTERLAB_WORKSPACES_DIR", str(service_root / "workspaces"))
os.environ.setdefault("JUPYTERLAB_DIR", str(packages_root / "jupyterlab"))

notebooks = Path(os.environ.get("SERVICE_DATA_PATH", service_root / "notebooks")).resolve()
for folder in [notebooks, Path(os.environ["JUPYTER_DATA_DIR"]), Path(os.environ["JUPYTER_CONFIG_DIR"]), Path(os.environ["JUPYTER_RUNTIME_DIR"]), Path(os.environ["JUPYTERLAB_WORKSPACES_DIR"])]:
    folder.mkdir(parents=True, exist_ok=True)

seed = app_root / "notebooks"
if seed.exists() and not any(notebooks.iterdir()):
    import shutil
    shutil.copytree(seed, notebooks, dirs_exist_ok=True)

from jupyterlab.labapp import main

host = os.environ.get("JUPYTERLAB_HOST", "127.0.0.1")
port = os.environ.get("SERVICE_PORT") or os.environ.get("JUPYTERLAB_PORT") or "8888"
sys.argv = [
    "jupyter-lab",
    "--ServerApp.allow_remote_access=True",
    "--ServerApp.allow_origin=*",
    f"--ServerApp.root_dir={notebooks}",
    "--no-browser",
    f"--ServerApp.ip={host}",
    f"--ServerApp.port={port}",
    "--ServerApp.port_retries=0",
    "--ServerApp.token=",
    "--ServerApp.password=",
    "--ServerApp.disable_check_xsrf=True",
    "--ServerApp.terminals_enabled=False",
    "--NotebookApp.terminals_enabled=False",
]
raise SystemExit(main())
`;

const stopSource = String.raw`import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

package_root = Path(__file__).resolve().parent
packages_root = package_root / "python-packages"
service_root = Path(os.environ.get("SERVICE_ROOT", os.getcwd())).resolve()
sys.path.insert(0, str(packages_root))

os.environ.setdefault("JUPYTER_RUNTIME_DIR", str(service_root / "runtime"))

port = os.environ.get("SERVICE_PORT") or os.environ.get("JUPYTERLAB_PORT") or "8888"
host = os.environ.get("JUPYTERLAB_HOST", "127.0.0.1")
url = f"http://{host}:{port}/api/shutdown"
request = urllib.request.Request(url, method="POST", data=b"")

try:
    urllib.request.urlopen(request, timeout=5).read()
except urllib.error.HTTPError as error:
    if error.code not in (200, 204, 404):
        raise
except urllib.error.URLError:
    raise SystemExit(0)

deadline = time.time() + 20
while time.time() < deadline:
    try:
        urllib.request.urlopen(f"http://{host}:{port}/api", timeout=1).read()
    except urllib.error.URLError:
        raise SystemExit(0)
    time.sleep(0.25)

raise SystemExit(f"JupyterLab did not stop after POST {url}")
`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageJupyterLab();
}
