import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getModelProviderBrand,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import type { ReasoningLevelDescriptor } from "./modelFamilyGrouping";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  badge?: "new" | "beta" | undefined;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
  /**
   * Reasoning-level descriptor for this model. When present and the row is
   * selected, a compact effort pill renders next to the model name showing
   * the current level. Clicking cycles through the available options.
   */
  reasoningDescriptor?: ReasoningLevelDescriptor | null;
  /**
   * Current reasoning level label (e.g. "High") for the selected model.
   * Shown in the effort pill when `reasoningDescriptor` is present.
   */
  reasoningLabel?: string | null;
  onReasoningLevelChange?: (nextValue: string) => void;
}) {
  const modelProviderBrand = getModelProviderBrand(props.driverKind, props.model);
  const ProviderIcon = modelProviderBrand.icon;
  const providerLabel =
    props.driverKind === "devin"
      ? `${props.providerDisplayName} · ${modelProviderBrand.label}`
      : props.model.subProvider
        ? `${props.providerDisplayName} · ${props.model.subProvider}`
        : props.providerDisplayName;

  const showReasoningPill =
    props.isSelected &&
    props.reasoningDescriptor !== null &&
    props.reasoningDescriptor !== undefined &&
    props.reasoningDescriptor.options.length > 1;

  const cycleReasoningLevel = () => {
    const descriptor = props.reasoningDescriptor;
    if (!descriptor || !props.onReasoningLevelChange) return;
    const currentIndex = descriptor.options.findIndex(
      (option) => option.id === descriptor.currentValue,
    );
    const nextIndex = (currentIndex + 1) % descriptor.options.length;
    const nextOption = descriptor.options[nextIndex] ?? descriptor.options[0];
    if (nextOption) {
      props.onReasoningLevelChange(nextOption.id);
    }
  };

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.badge ? (
            <span
              className={cn(
                "shrink-0 rounded border px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide",
                props.badge === "new"
                  ? "border-update/35 bg-update/15 text-update-foreground"
                  : "border-warning/35 bg-warning/15 text-warning-foreground",
              )}
              aria-label={props.badge === "new" ? "New model" : "Beta model"}
            >
              {props.badge === "new" ? "New" : "Beta"}
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
          {showReasoningPill && props.reasoningLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "shrink-0 rounded border border-border/70 bg-muted/60 px-1.5 py-px text-[10px] font-medium leading-none text-muted-foreground transition-colors",
                      props.onReasoningLevelChange &&
                        "cursor-pointer hover:border-border hover:bg-muted hover:text-foreground",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      cycleReasoningLevel();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    disabled={!props.onReasoningLevelChange}
                    aria-label={`Reasoning: ${props.reasoningLabel}`}
                  >
                    {props.reasoningLabel}
                  </button>
                }
              />
              <TooltipPopup side="top" align="center">
                {props.onReasoningLevelChange
                  ? `Reasoning: ${props.reasoningLabel}. Click to change.`
                  : `Reasoning: ${props.reasoningLabel}`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderIcon className="size-3 shrink-0" />
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
