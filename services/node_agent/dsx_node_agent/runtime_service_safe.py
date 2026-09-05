from __future__ import annotations

# ruff: noqa: I001

import shutil

from dsx_node_agent import runtime_service as runtime
from dsx_node_agent.provisioner import ProvisionRequest, ProvisionerError, ProvisioningEngine


class SafeRuntimeProvisioningEngine(runtime.RuntimeProvisioningEngine):
    """Add full rollback when Trial runtime activation fails before ready."""

    def _rollback_trial_data(self, request: ProvisionRequest) -> None:
        profile = self.config.profiles[request.template_id]
        marker = self._read_marker(request.database_name) if self._database_exists(request.database_name) else None
        if marker != (request.tenant_id, request.template_id):
            raise ProvisionerError("runtime_rollback_marker_mismatch")

        target_filestore = profile.filestore_root.resolve() / request.database_name
        if target_filestore.is_symlink():
            raise ProvisionerError("runtime_rollback_filestore_symlink_blocked")

        rollback_failed = False
        if target_filestore.exists():
            try:
                shutil.rmtree(target_filestore)
            except OSError:
                rollback_failed = True

        try:
            self._drop_database(request.database_name)
            if self._database_exists(request.database_name):
                rollback_failed = True
        except ProvisionerError:
            rollback_failed = True

        if rollback_failed:
            raise ProvisionerError("runtime_rollback_failed")

    def provision(self, request: ProvisionRequest) -> dict[str, str]:
        result = ProvisioningEngine.provision(self, request)
        if request.environment_kind != "trial":
            return result

        lifecycle = runtime._runtime()
        if not lifecycle.config.enabled:
            self._rollback_trial_data(request)
            raise ProvisionerError("runtime_disabled")

        profile = self.config.profiles[request.template_id]
        try:
            lifecycle.ensure(request, profile)
        except ProvisionerError as runtime_error:
            try:
                self._rollback_trial_data(request)
            except ProvisionerError as rollback_error:
                raise rollback_error from runtime_error
            raise
        return result


def main() -> None:
    runtime.RuntimeProvisioningEngine = SafeRuntimeProvisioningEngine
    runtime.main()


if __name__ == "__main__":
    main()
