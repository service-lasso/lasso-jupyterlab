# JavaScript Kernel Contract

`lasso-jupyterlab` is a Python-backed JupyterLab service. It does not ship a JavaScript kernel.

## Decision

The service must not advertise a `javascript` kernelspec until the kernel can run without host-specific native build tooling.

## Reason

The candidate IJavascript stack resolves to:

- `ijavascript@5.2.1`
- `jp-kernel@2`
- `jmp@2`
- `zeromq@5.3.1`

`zeromq@5.3.1` does not provide a compatible native prebuild for the current Service Lasso `@node` provider. When tested against `@node v24.15.0`, the kernel process exits before Jupyter receives `kernel_info`.

## Verification

`npm test` validates this boundary by:

- packaging the service artifact;
- downloading the released `@python` provider;
- starting JupyterLab with the packaged launcher;
- checking `GET /api`;
- checking `GET /api/kernelspecs`;
- failing if an unsupported `javascript` kernelspec is exposed;
- running the packaged stop helper and confirming the process exits.

If a future implementation adds a maintained JavaScript kernel, the verifier must execute a minimal JavaScript cell before the service advertises that kernel.
