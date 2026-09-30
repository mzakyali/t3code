import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import {
  deriveProviderHandoffDestinations,
  deriveProviderHandoffModelOptions,
} from "../providerHandoff";
import { ModelPickerContent } from "./chat/ModelPickerContent";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

export interface ProviderHandoffRequestInput {
  /** Shown in the dialog header so the move's target conversation is clear. */
  readonly threadTitle: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Environment settings merged with client settings (same merge the composer uses). */
  readonly settings: UnifiedSettings;
  /** The instance currently bound to the thread, when known. */
  readonly currentInstanceId: ProviderInstanceId | null;
}

type Request = ProviderHandoffRequestInput & {
  readonly id: number;
  readonly resolve: (choice: ModelSelection | null) => void;
};

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let nextRequestId = 0;

export function requestProviderHandoff(
  input: ProviderHandoffRequestInput,
): Promise<ModelSelection | null> {
  useRequest.getState().request?.resolve(null);
  const id = (nextRequestId += 1);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, id, resolve } }));
}

function finish(choice: ModelSelection | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function ProviderHandoffDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  // Keyed per request so a re-requested dialog never inherits the pending
  // choice a previous request left in state.
  return request ? <ProviderHandoffDialog key={request.id} request={request} /> : null;
}

function ProviderHandoffDialog({ request }: { request: ProviderHandoffRequestInput }) {
  const destinations = useMemo(
    () =>
      deriveProviderHandoffDestinations({
        providers: request.providers,
        settings: request.settings,
        currentInstanceId: request.currentInstanceId,
      }),
    [request.providers, request.settings, request.currentInstanceId],
  );
  const modelOptionsByInstance = useMemo(
    () => deriveProviderHandoffModelOptions(request.settings, destinations),
    [request.settings, destinations],
  );
  const firstDestination = destinations[0];

  // Picking a row only marks it — the model stays "pending" until Continue so
  // the reasoning pill on the selected row can contribute options to the
  // dispatched ModelSelection.
  const [choice, setChoice] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
  } | null>(null);

  const confirm = () => {
    if (!choice) return;
    finish(createModelSelection(choice.instanceId, choice.model, choice.options));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup
        className="w-fit max-w-[calc(100vw-2rem)]"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <DialogHeader>
          <DialogTitle>Continue with another provider</DialogTitle>
          <DialogDescription>
            {`“${request.threadTitle}” picks up on the provider you choose, with a summary of the conversation so far.`}
          </DialogDescription>
        </DialogHeader>
        {firstDestination ? (
          <>
            <ModelPickerContent
              activeInstanceId={choice?.instanceId ?? firstDestination.instanceId}
              model={choice?.model ?? ""}
              lockedProvider={null}
              // Favorites can point at instances that are not destinations;
              // the rail would open on a list that cannot be acted on.
              showFavorites={false}
              instanceEntries={destinations}
              modelOptionsByInstance={modelOptionsByInstance}
              terminalOpen={false}
              onRequestClose={() => finish(null)}
              onInstanceModelChange={(instanceId, model) =>
                // A different model has its own option descriptors; carry
                // nothing over.
                setChoice({ instanceId, model, options: undefined })
              }
              activeModelOptions={choice?.options}
              onModelOptionsChange={(nextOptions) =>
                setChoice((prev) => (prev ? { ...prev, options: nextOptions } : prev))
              }
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => finish(null)}>
                Cancel
              </Button>
              <Button onClick={confirm} disabled={choice === null}>
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogPanel className="w-90">
              <p className="text-sm text-muted-foreground">
                No other provider can receive this thread right now.
              </p>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => finish(null)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
