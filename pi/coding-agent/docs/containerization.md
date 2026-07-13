# Containerization

Magenta runs with the current user's permissions by default, but in some cases you will want more control over its filesystem, process, network, and credential access.

There are two general options. You can either
1. run the whole `magenta` process inside an isolated environment, or
2. run `magenta` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `magenta` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `magenta` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway |

Extensions run wherever the `magenta` process runs. If you run host Magenta with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](../examples/extensions/gondolin) when you want Magenta on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R pi/coding-agent/examples/extensions/gondolin ~/.magenta/agent/extensions/gondolin
cd ~/.magenta/agent/extensions/gondolin
npm install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
magenta -e ~/.magenta/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `magenta` process in Docker when you want the simplest local container boundary. The repository includes [`Dockerfile.headless`](../../../Dockerfile.headless), which builds the current checkout and its version-matched workspace runtime instead of installing a floating package. It uses `tini` for signal forwarding/child reaping and runs as the unprivileged `magenta` user.

Build and validate the image:

```bash
docker build -t magenta-headless -f Dockerfile.headless .

docker run --rm \
  -e ANTHROPIC_API_KEY \
  magenta-headless \
  --validate-config --mode json --no-session --model anthropic/claude-sonnet-4-6
```

Run a one-shot task:

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  magenta-headless \
  --print --mode json --no-session --approve \
  --background-policy error \
  --model anthropic/claude-sonnet-4-6 \
  "Run the repository tests and fix the failure"
```

The bind mount exposes the current directory as `/workspace`; writes affect the host. The image stores Magenta state under `/home/magenta/.magenta/agent`. Add a named volume there only when persistence is intentional:

```bash
-v magenta-agent-home:/home/magenta/.magenta/agent
```

Do not mount the host `~/.magenta/agent` into untrusted containers because that exposes host credentials and sessions. The image disables version checks and telemetry by default but does not disable provider inference or tool network access.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch Magenta inside an OpenShell sandbox image that contains the installed package:

```bash
openshell sandbox create --name magenta-sandbox --from <source-with-magenta> -- magenta
```

In this pattern, the whole `magenta` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload magenta-sandbox ./repo /workspace
openshell sandbox download magenta-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure Magenta to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.
