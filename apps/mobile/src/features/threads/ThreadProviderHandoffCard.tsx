import * as Haptics from "expo-haptics";
import type { ColorValue } from "react-native";
import { Pressable, View } from "react-native";
import type { ServerProvider } from "@t3tools/contracts";
import { providerHandoffCardModel } from "@t3tools/client-runtime/work-log/provider-handoff";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { ThreadDisclosureChevron } from "./thread-work-log";

/**
 * A provider handoff rendered as its own card: the instance transition heads
 * it, the handoff brief sits behind a disclosure, and a badge marks handoffs
 * that fell back to the deterministic brief. Failures carry the server's
 * detail as an error card. Disclosure state rides the feed's shared expanded
 * row set so virtualization does not reset it.
 */
export function ThreadProviderHandoffCard(props: {
  readonly activity: ThreadFeedActivity;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: () => void;
  readonly onCopy: () => void;
}) {
  const model = providerHandoffCardModel({
    info: props.activity.workEntry.providerHandoff,
    providers: props.providers,
  });
  if (model === null) {
    return null;
  }
  const canExpand = model.body !== null;

  return (
    <View className="-mx-1 mb-1 px-1">
      <Pressable
        accessibilityRole={canExpand ? "button" : undefined}
        accessibilityState={canExpand ? { expanded: props.expanded } : undefined}
        accessibilityLabel={model.title}
        accessibilityHint={
          canExpand
            ? `Double tap to ${props.expanded ? "hide" : "show"} the handoff brief. Long press to copy.`
            : "Long press to copy."
        }
        hitSlop={4}
        onPress={() => {
          if (!canExpand) return;
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        onLongPress={props.onCopy}
        className={cn(
          "rounded-xl border px-2.5 py-2",
          model.failed ? "border-danger-border bg-danger" : "border-border-subtle bg-card",
        )}
      >
        <View className="flex-row items-center gap-2">
          <View className="h-6 w-6 shrink-0 items-center justify-center">
            {model.failed ? (
              <SymbolView
                name="exclamationmark.circle"
                size={14}
                weight="medium"
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
            ) : (
              <SymbolView
                name="arrow.left.arrow.right"
                size={14}
                weight="medium"
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            )}
          </View>
          <Text
            className={cn(
              "min-w-0 flex-1 text-sm",
              model.failed ? "font-t3-medium text-danger-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {model.title}
          </Text>
          {model.degraded ? (
            <View className="shrink-0 rounded-md border border-warning-border bg-warning px-1.5 py-0.5">
              <Text className="font-t3-medium text-2xs text-warning-foreground">
                Fallback brief
              </Text>
            </View>
          ) : null}
          {canExpand ? (
            <ThreadDisclosureChevron
              expanded={props.expanded}
              collapsedDirection="down"
              size={11}
              tintColor={props.iconSubtleColor}
            />
          ) : null}
        </View>
        {props.expanded && model.body !== null ? (
          <View className="ml-8 mt-1.5 border-l border-border pl-3">
            <Text
              selectable
              className={cn(
                "text-2xs leading-normal",
                model.failed ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {model.body}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}
