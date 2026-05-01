# URL Contracts

## UI

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/lab` | JupyterLab UI |
| `GET` | `/tree` | notebook file browser |

## API And Health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api` | Jupyter server API root and Service Lasso healthcheck |
| `GET` | `/api/status` | Jupyter server status |
| `GET` | `/api/contents` | notebook root contents |

The service disables token auth and terminals for local managed runtime use. Notebook content is rooted at `${SERVICE_DATA_PATH}`.

## Stop Contract

The Service Lasso stop action runs `lasso-jupyterlab-stop.py`, which posts `${JUPYTERLAB_URL}/api/shutdown` and waits for the service port to close. Service Lasso process termination remains the fallback if the process has already exited.
