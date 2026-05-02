# lasso-jupyterlab

Release-backed JupyterLab package for Service Lasso.

This repo publishes JupyterLab as an app-owned notebook service. The current release targets Windows because the current `@python` provider publishes Windows Python `3.11.5` artifacts only.

## What It Packages

- JupyterLab from `app/requirements.txt`
- A Service Lasso launcher, `lasso-jupyterlab.py`, that prepares runtime folders and starts `jupyter lab`
- A stop helper, `lasso-jupyterlab-stop.py`, that posts Jupyter's shutdown endpoint for the configured port

This service deliberately does not ship an IJavascript kernel. IJavascript currently depends on `zeromq@5`, which does not provide a compatible native prebuild for the current `@node` provider and would require ad-hoc native build tooling. JupyterLab itself, notebook storage, HTTP health, absence of an unsupported JavaScript kernelspec, and stop behavior are validated by the release workflow. See [docs/javascript-kernel.md](docs/javascript-kernel.md).

Release artifacts are:

- `lasso-jupyterlab-1.0.0-win32.zip`
- `service.json`
- `SHA256SUMS.txt`

## Defaults

- Service id: `jupyterlab`
- Port: `8888`
- Notebook data path: `notebooks`
- Token: disabled for local managed runtime use
- Terminals: disabled
- Dependencies: `@python`
- Healthcheck: `GET /api`

The manifest exports `JUPYTERLAB_URL` and `JUPYTERLAB_PORT` through `globalenv`.

## Local Verification

```powershell
npm install
npm test
```

The verifier packages the Windows artifact, downloads the released `@python` provider, extracts both artifacts, starts JupyterLab with the provider Python, checks `GET /api`, proves the unsupported JavaScript kernelspec is not advertised, runs the packaged stop helper, and confirms the process exits.

## URL Contracts

See [docs/url-contracts.md](docs/url-contracts.md).
