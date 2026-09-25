import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AgentSessionListedThread, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { newProjectId, randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { agentSessionImport, agentSessionListThreads } from "../../state/agentSessions";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

interface ImportDevinSessionsDialogTarget {
  readonly environmentId: EnvironmentId;
  /** Scope the picker to sessions recorded under this project's root. */
  readonly projectId?: ProjectId;
}

/**
 * Which import picker is open, set by whichever entry point asked (command
 * palette, project settings) and rendered once at the app root so the dialog
 * outlives the palette that closes the moment its command runs.
 */
const importDevinSessionsDialogTargetAtom = Atom.make<ImportDevinSessionsDialogTarget | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("agent-sessions:import-devin-dialog"));

export function openImportDevinSessionsDialog(target: ImportDevinSessionsDialogTarget): void {
  appAtomRegistry.set(importDevinSessionsDialogTargetAtom, target);
}

export function ImportDevinSessionsDialogHost() {
  const target = useAtomValue(importDevinSessionsDialogTargetAtom);
  if (target === null) return null;
  return (
    <ImportDevinSessionsDialog
      key={`${target.environmentId}:${target.projectId ?? "all"}`}
      target={target}
      onClose={() => appAtomRegistry.set(importDevinSessionsDialogTargetAtom, null)}
    />
  );
}

function workspaceBasename(workspaceRoot: string): string {
  return workspaceRoot.split(/[\\/]/).findLast((part) => part !== "") ?? workspaceRoot;
}

function ImportDevinSessionsDialog({
  target,
  onClose,
}: {
  readonly target: ImportDevinSessionsDialogTarget;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const listAtom = useMemo(
    () =>
      agentSessionListThreads({
        environmentId: target.environmentId,
        input: target.projectId === undefined ? {} : { projectId: target.projectId },
      }),
    [target],
  );
  const listResult = useAtomValue(listAtom);
  const listData = AsyncResult.value(listResult);
  const threads = listData._tag === "Some" ? listData.value.threads : [];
  const listError =
    listResult._tag === "Failure" ? formatEnvironmentQueryError(listResult.cause) : null;
  const listPending = listResult.waiting || listResult._tag === "Initial";

  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });

  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const selectable = useMemo(() => threads.filter((thread) => !thread.imported), [threads]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return threads;
    return threads.filter(
      (thread) =>
        thread.title.toLowerCase().includes(needle) ||
        thread.providerSessionId.toLowerCase().includes(needle) ||
        thread.workspaceRoot.toLowerCase().includes(needle),
    );
  }, [threads, query]);

  const groups = useMemo(() => {
    const byWorkspace = new Map<string, Array<AgentSessionListedThread>>();
    for (const thread of visible) {
      const group = byWorkspace.get(thread.workspaceRoot);
      if (group === undefined) {
        byWorkspace.set(thread.workspaceRoot, [thread]);
      } else {
        group.push(thread);
      }
    }
    return Array.from(byWorkspace.entries());
  }, [visible]);

  const toggleSession = (thread: AgentSessionListedThread, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(thread.providerSessionId);
      else next.delete(thread.providerSessionId);
      return next;
    });
  };

  const runImport = useCallback(async () => {
    if (pending) return;
    const selected = selectable.filter((thread) => selectedIds.has(thread.providerSessionId));
    if (selected.length === 0) return;
    setPending(true);
    setImportError(null);

    // Sessions in different directories belong to different projects: group by
    // workspace so each import lands under the project rooted at that path.
    const byWorkspace = new Map<string, Array<AgentSessionListedThread>>();
    for (const thread of selected) {
      const group = byWorkspace.get(thread.workspaceRoot);
      if (group === undefined) {
        byWorkspace.set(thread.workspaceRoot, [thread]);
      } else {
        group.push(thread);
      }
    }

    let importedCount = 0;
    let failedCount = 0;
    for (const [workspaceRoot, rows] of byWorkspace) {
      let projectId = target.projectId ?? rows[0]!.projectId;
      if (projectId === undefined) {
        const createdProjectId = newProjectId();
        const created = await createProject({
          environmentId: target.environmentId,
          input: {
            projectId: createdProjectId,
            commandId: CommandId.make(`agent-sessions:import:${randomUUID()}`),
            title: workspaceBasename(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (created._tag !== "Success") {
          if (!isAtomCommandInterrupted(created)) failedCount += rows.length;
          continue;
        }
        projectId = createdProjectId;
      }
      const result = await importSessions({
        environmentId: target.environmentId,
        input: {
          projectId,
          expectedWorkspaceRoot: workspaceRoot,
          sessions: rows.map((row) => ({
            provider: "devin",
            providerSessionId: row.providerSessionId,
          })),
        },
      });
      if (result._tag === "Success") {
        importedCount += result.value.importedCount;
        failedCount += result.value.skippedCount;
      } else if (!isAtomCommandInterrupted(result)) {
        failedCount += rows.length;
      }
    }

    setPending(false);
    registry.refresh(listAtom);
    setSelectedIds(new Set());
    if (importedCount > 0) {
      toastManager.add({
        type: "success",
        title: `Imported ${importedCount} Devin ${importedCount === 1 ? "session" : "sessions"}`,
      });
    }
    if (failedCount > 0) {
      setImportError(
        `${failedCount} ${failedCount === 1 ? "session could" : "sessions could"} not be imported.`,
      );
      return;
    }
    if (importedCount === 0) {
      setImportError("No sessions were imported.");
      return;
    }
    onClose();
  }, [
    createProject,
    importSessions,
    listAtom,
    onClose,
    pending,
    registry,
    selectable,
    selectedIds,
    target,
  ]);

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Devin sessions</DialogTitle>
          <DialogDescription>
            {target.projectId === undefined
              ? "Pick sessions to import as resumable threads. Sessions are grouped by the folder they ran in; a project is created when none exists."
              : "Pick sessions to import into this project as resumable threads."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            placeholder="Filter sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {listPending && listData._tag === "None" ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size="md" />
              Looking for Devin sessions…
            </div>
          ) : listError !== null ? (
            <div className="flex items-center justify-between gap-3 py-4 text-sm text-muted-foreground">
              <span>Could not list Devin sessions. {listError}</span>
              <Button variant="ghost" size="sm" onClick={() => registry.refresh(listAtom)}>
                Retry
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {threads.length === 0
                ? "No Devin sessions found on this environment."
                : "No sessions match the filter."}
            </p>
          ) : (
            <ScrollArea scrollFade className="max-h-96">
              <div className="space-y-4 pr-3">
                {groups.map(([workspaceRoot, rows]) => (
                  <fieldset key={workspaceRoot} className="min-w-0 space-y-0.5" disabled={pending}>
                    <legend className="mb-1 flex max-w-full items-baseline gap-2 text-xs font-medium text-muted-foreground">
                      <span className="truncate">{workspaceRoot}</span>
                    </legend>
                    {rows.map((thread) => (
                      <label
                        key={thread.providerSessionId}
                        className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default has-disabled:opacity-60"
                      >
                        <Checkbox
                          className="mt-0.5"
                          disabled={thread.imported}
                          checked={selectedIds.has(thread.providerSessionId)}
                          onCheckedChange={(checked) => toggleSession(thread, checked === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{thread.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[
                              thread.updatedAt === null
                                ? null
                                : formatRelativeTimeLabel(thread.updatedAt),
                              thread.model,
                              `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`,
                              thread.providerSessionId,
                            ]
                              .filter((part) => part !== null)
                              .join(" · ")}
                          </span>
                        </span>
                        {thread.imported ? (
                          <span className="shrink-0 text-xs text-muted-foreground">Imported</span>
                        ) : null}
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </ScrollArea>
          )}
          {importError !== null ? (
            <p className="text-sm text-destructive" role="alert">
              {importError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void runImport()}
            disabled={pending || selectedIds.size === 0}
          >
            {pending
              ? "Importing…"
              : `Import ${selectedIds.size} ${selectedIds.size === 1 ? "session" : "sessions"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
