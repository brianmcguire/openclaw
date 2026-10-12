// Exec approval policy file helpers without the broad infra-runtime barrel.
import { readExecApprovalsSnapshot as readExecApprovalsSnapshotSync } from "../infra/exec-approvals.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** @deprecated Await readExecApprovalsSnapshotAsync; removed in the next Plugin SDK major. */
function readExecApprovalsSnapshotDeprecated() {
  warnPluginSdkDeprecation({
    family: "exec-approvals-sync-read",
    method: "readExecApprovalsSnapshot",
    replacement: "readExecApprovalsSnapshotAsync",
  });
  return readExecApprovalsSnapshotSync();
}

export { readExecApprovalsSnapshotDeprecated as readExecApprovalsSnapshot };

export {
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsSnapshotAsync,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
  type ExecApprovalsFile,
} from "../infra/exec-approvals.js";
