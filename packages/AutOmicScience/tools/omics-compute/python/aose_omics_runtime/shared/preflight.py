"""omics_preflight — verify the active Pixi environment is ready for a modality.

Ported from BioAgent AutOmicScience (crates/aose-tools/src/omics_typed.rs).

Key property preserved: this runs *inside* the per-modality isolated Pixi
environment (the harness launcher selects it via --environment <env>), so
`import <pkg>` here probes the exact interpreter that will run the analysis.
A green preflight therefore guarantees no ModuleNotFoundError at run time —
which a `pixi install --dry-run` lockfile check cannot promise.

Emits a single JSON object on stdout: {ready, modality, pythonBin,
blocker?, fix?, missingPackages?, gpuAvailable?, packages?}.
"""

import importlib.util
import json
import os
import sys

# modality -> required import names. Append-only; kept in lockstep with the
# pixi.toml features and the modality->env table in omics-compute.toml.
MODALITY_REQUIREMENTS = {
    "scrna": ["anndata", "scanpy", "scvi", "leidenalg", "igraph"],
    "spatial": ["anndata", "scanpy", "squidpy", "spatialdata", "spatialdata_io"],
    "scatac": ["anndata", "scanpy", "muon", "snapatac2"],
    "multiome": ["anndata", "scanpy", "muon", "mudata"],
}

# modality -> the isolated env id it should run in (for fix hints only; the
# harness launcher already selected the env). Mirrors omics-compute.toml.
MODALITY_ENV = {
    "scrna": "task1",
    "spatial": "task2",
    "scatac": "task4",
    "multiome": "task3",
}

# Reverse map: active Pixi env id -> modality. Lets preflight recover the
# modality from PIXI_ENVIRONMENT_NAME when the launcher stripped --modality
# (it uses that arg to select the env, then drops it from argv).
ENV_MODALITY = {env: modality for modality, env in MODALITY_ENV.items()}


def _module_importable(name: str) -> bool:
    """True if `import name` would succeed, without importing heavy deps."""
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        # A parent package that raises on import surfaces here → treat as missing.
        return False


def _gpu_available() -> bool:
    """GPU probe: torch.cuda first (scvi/scANVI path), rapids fallback."""
    try:
        import torch

        if bool(torch.cuda.is_available()):
            return True
    except Exception:
        pass
    return _module_importable("rapids_singlecell")


def main(args):
    active_env = os.environ.get("PIXI_ENVIRONMENT_NAME")
    # Prefer the explicit flag; otherwise recover the modality from the active
    # Pixi environment the launcher selected.
    modality = args.modality or ENV_MODALITY.get(active_env)
    required = MODALITY_REQUIREMENTS.get(modality)
    if required is None:
        print(
            json.dumps(
                {
                    "ready": False,
                    "modality": modality,
                    "activeEnv": active_env,
                    "pythonBin": sys.executable,
                    "blocker": (
                        f"Unknown modality: {args.modality}"
                        if args.modality
                        else f"Could not resolve modality from active env {active_env!r}"
                    ),
                    "fix": "Use one of: " + ", ".join(sorted(MODALITY_REQUIREMENTS)),
                }
            )
        )
        return

    env_id = MODALITY_ENV.get(modality)

    missing = [pkg for pkg in required if not _module_importable(pkg)]
    gpu_available = _gpu_available() if getattr(args, "check_gpu", False) else None

    result = {
        "modality": modality,
        "pythonBin": sys.executable,
        "activeEnv": active_env,
    }
    if gpu_available is not None:
        result["gpuAvailable"] = gpu_available

    if missing:
        result["ready"] = False
        result["missingPackages"] = missing
        result["blocker"] = (
            f"Environment missing required packages for {modality}: " + ", ".join(missing)
        )
        if env_id:
            result["fix"] = (
                f"Reinstall the Pixi '{env_id}' environment:\n"
                f"  pixi install --manifest-path pixi.toml -e {env_id}\n"
                "If packages are still missing, add them to pixi.toml, then "
                f"`pixi lock` and `pixi install -e {env_id}`."
            )
        else:
            result["fix"] = (
                "Install the required packages into the active Pixi environment; "
                "missing imports: " + " ".join(missing)
            )
    else:
        result["ready"] = True
        result["packages"] = required

    print(json.dumps(result))
