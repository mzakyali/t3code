import type { UsageAccountConsumption, UsageProviderKind } from "@t3tools/contracts";
import { CheckIcon, DownloadIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import { usageToCsv, usageToJson } from "./usageExport";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

function filterUsagePeriods<T extends DailyTotals | HourlyTotals>(
  periods: readonly T[],
  providerFilter: UsageProviderKind | "all",
): readonly T[] {
  if (providerFilter === "all") return periods;
  return periods.map((period) => {
    const selected = period.byProvider.get(providerFilter);
    return {
      ...period,
      costUsd: selected?.costUsd ?? 0,
      totalTokens: selected?.totalTokens ?? 0,
      byProvider: selected
        ? new Map([[providerFilter, selected]])
        : new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
    } as T;
  });
}

export function UsagePage() {
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [providerFilter, setProviderFilter] = useState<UsageProviderKind | "all">("all");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const visibleProviders = useMemo(
    () =>
      providerFilter === "all"
        ? activeProviders
        : activeProviders.filter((provider) => provider === providerFilter),
    [activeProviders, providerFilter],
  );
  const visibleDaily = useMemo(
    () => filterUsagePeriods(merged.daily, providerFilter),
    [merged.daily, providerFilter],
  );
  const visibleHourly = useMemo(
    () => filterUsagePeriods(merged.hourly, providerFilter),
    [merged.hourly, providerFilter],
  );
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? visibleHourly : visibleDaily).toReversed(),
    [isPast24Hours, visibleDaily, visibleHourly],
  );
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? merged.models
            .filter((model) => providerFilter === "all" || model.provider === providerFilter)
            .toSorted(
              (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
            )
        : merged.models.filter(
            (model) => providerFilter === "all" || model.provider === providerFilter,
          ),
    [breakdown, merged.models, metric, providerFilter],
  );
  const timeValueColumnWidth = `${60 / (visibleProviders.length + 2)}%`;

  const downloadExport = (format: "csv" | "json") => {
    if (typeof document === "undefined") return;
    const body = format === "csv" ? usageToCsv(merged, window) : usageToJson(merged, window);
    const blob = new Blob([body], {
      type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `t3-usage-${window.sinceDay}-${window.untilDay}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };
  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
        <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
          <span className="truncate">{windowLabel}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 lg:flex">
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          {(["cost", "tokens"] as const).map((option) => (
            <Toggle key={option} value={option}>
              {option === "cost" ? "Cost" : "Tokens"}
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button onClick={refreshWindow} aria-label="Refresh usage" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          onClick={() => downloadExport("csv")}
          aria-label="Export usage as CSV"
          size="icon-sm"
          variant="ghost"
          title="Export usage as CSV"
        >
          <DownloadIcon className="size-3.5" />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 lg:hidden">
        <Select
          value={metric}
          onValueChange={(value) => {
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{metric === "cost" ? "Cost" : "Tokens"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="cost">Cost</SelectItem>
            <SelectItem value="tokens">Tokens</SelectItem>
          </SelectPopup>
        </Select>
        <Select value={String(windowDays)} onValueChange={(value) => selectWindow(Number(value))}>
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option.days} value={String(option.days)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button onClick={refreshWindow} aria-label="Refresh usage" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <Button
          onClick={() => downloadExport("csv")}
          aria-label="Export usage as CSV"
          size="icon-sm"
          variant="ghost"
          title="Export usage as CSV"
        >
          <DownloadIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {settling ? (
              <>
                {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
                <UsageSkeleton />
              </>
            ) : (
              <>
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                  accountUsage={merged.accountUsage}
                />
                {merged.accountUsage !== null ? (
                  <DevinAccountUsageCard usage={merged.accountUsage} />
                ) : null}

                <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? `${formatCount(merged.sessions)} sessions · API estimate`
                          : `${formatCount(merged.sessions)} sessions`}
                      </span>
                    </div>

                    {activeProviders.map((provider) => {
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                      const providerSessions = totals?.sessions ?? 0;
                      const sessionLabel = `${formatCount(providerSessions)} ${
                        providerSessions === 1 ? "session" : "sessions"
                      }`;
                      return (
                        <div key={provider} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                                <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                                  {sessionLabel}
                                </span>
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                              {metric === "cost"
                                ? formatUsd(totals?.costUsd ?? 0)
                                : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {isPast24Hours ? "Hourly" : "Daily"}{" "}
                      {metric === "tokens" ? "processed tokens" : "cost"}
                    </h2>
                    <UsageProviderChart
                      providers={visibleProviders}
                      days={days}
                      daily={visibleDaily}
                      hours={hours}
                      hourly={visibleHourly}
                      metric={metric}
                      referenceTime={window.untilTime}
                      resolution={isPast24Hours ? "hour" : "day"}
                      timeZone={window.timeZone}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                    <Metric
                      label="Cache savings"
                      value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      Breakdown
                      {providerFilter === "all"
                        ? ""
                        : ` · ${PROVIDER_PRESENTATION[providerFilter].label}`}
                    </h2>
                    <div className="flex items-center gap-2">
                      <Select
                        value={providerFilter}
                        onValueChange={(value) => {
                          if (
                            value === "all" ||
                            PROVIDER_ORDER.includes(value as UsageProviderKind)
                          ) {
                            setProviderFilter(value as UsageProviderKind | "all");
                          }
                        }}
                      >
                        <SelectTrigger
                          aria-label="Filter usage by provider"
                          size="compact"
                          variant="ghost"
                        >
                          <SelectValue>
                            {providerFilter === "all"
                              ? "All providers"
                              : PROVIDER_PRESENTATION[providerFilter].label}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          <SelectItem value="all">All providers</SelectItem>
                          {PROVIDER_ORDER.filter(
                            (provider) => PROVIDER_PRESENTATION[provider] !== undefined,
                          ).map((provider) => (
                            <SelectItem key={provider} value={provider}>
                              {PROVIDER_PRESENTATION[provider].label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <ToggleGroup
                        aria-label="Usage breakdown"
                        variant="segmented"
                        value={[breakdown]}
                        onValueChange={(next) => {
                          const value = next[0];
                          if (value === "model" || value === "time") setBreakdown(value);
                        }}
                      >
                        {(
                          [
                            { value: "model", label: "Model" },
                            { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                          ] as const
                        ).map((option) => (
                          <Toggle key={option.value} value={option.value}>
                            {option.label}
                          </Toggle>
                        ))}
                      </ToggleGroup>
                    </div>
                  </div>

                  {breakdown === "model" ? (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                        <col className="w-1/5" />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">Model</th>
                          <th className="py-2 text-right font-normal">Cost</th>
                          <th className="py-2 text-right font-normal">Share</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownModels.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownModels.map((model) => (
                            <tr
                              key={`${model.provider}:${model.model}`}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                <span className="flex items-center gap-2">
                                  <ProviderMark provider={model.provider} className="size-3.5" />
                                  {model.model}
                                </span>
                              </td>
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(model.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatPercent(model.costShare)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(model.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        {visibleProviders.map((provider) => (
                          <col key={provider} style={{ width: timeValueColumnWidth }} />
                        ))}
                        <col style={{ width: timeValueColumnWidth }} />
                        <col style={{ width: timeValueColumnWidth }} />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                          {visibleProviders.map((provider) => (
                            <th key={provider} className="py-2 text-right font-normal">
                              {PROVIDER_PRESENTATION[provider].label}
                            </th>
                          ))}
                          <th className="py-2 text-right font-normal">Total</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPeriods.length === 0 ? (
                          <tr>
                            <td
                              colSpan={visibleProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownPeriods.map((period) => (
                            <tr
                              key={"hourStart" in period ? period.hourStart : period.day}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                {"hourStart" in period
                                  ? formatHourShort(period.hourStart, window.timeZone)
                                  : formatDayShort(period.day)}
                              </td>
                              {visibleProviders.map((provider) => (
                                <td
                                  key={provider}
                                  className="py-2 text-right text-muted-foreground tabular-nums"
                                >
                                  {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                </td>
                              ))}
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {formatUsd(period.costUsd)}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(period.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
  accountUsage,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
  readonly accountUsage: UsageAccountConsumption | null;
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  const hasDevinSource = environments.some((environment) =>
    environment.summary?.sources.some(
      (source) => source.fingerprint.provider === "devin" && source.status !== "missing",
    ),
  );
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    !hasDevinSource
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
      {hasDevinSource ? (
        <span>
          Devin ACP usage is read from this T3 server&apos;s local event logs. Devin account billing
          is kept separate from the local token/cost estimate
          {accountUsage?.status === "available" ? " and is shown below." : "."}
        </span>
      ) : null}
    </div>
  );
}

function formatAcus(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

/** Official Devin account units, deliberately kept separate from token costs. */
function DevinAccountUsageCard({ usage }: { readonly usage: UsageAccountConsumption }) {
  const statusMessage =
    usage.status === "notConfigured"
      ? "Optional account usage is not configured. Add DEVIN_API_KEY and DEVIN_ORG_ID as sensitive Devin provider environment variables."
      : usage.status === "forbidden"
        ? "The configured Devin API key cannot read organization consumption. Use a cog_ service key with ViewOrgConsumption permission."
        : usage.status === "failed"
          ? (usage.message ?? "Devin account consumption could not be loaded.")
          : null;

  return (
    <section className="flex flex-col gap-3 border border-border px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">Devin account usage</h2>
          <span className="text-xs text-muted-foreground">Official ACUs for this window</span>
        </div>
        {usage.status === "available" ? (
          <span className="text-lg font-medium text-foreground tabular-nums">
            {formatAcus(usage.totalAcus)} ACUs
          </span>
        ) : null}
      </div>

      {statusMessage !== null ? (
        <p className="text-xs text-muted-foreground">{statusMessage}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>{usage.days.length} billing days returned</span>
            <span>Source: {usage.source}</span>
            {usage.fetchedAt !== null ? (
              <span>Updated {formatDateTimeShort(usage.fetchedAt)}</span>
            ) : null}
          </div>
          {usage.days.length > 0 ? (
            <div className="grid gap-1 text-xs">
              {usage.days
                .toReversed()
                .slice(0, 5)
                .map((day) => (
                  <div key={day.day} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{formatDayShort(day.day)}</span>
                    <span className="text-foreground tabular-nums">
                      {formatAcus(day.acus)} ACUs
                    </span>
                  </div>
                ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? "1 device still scanning"
          : `${scanning.length} devices still scanning`}
      </span>
    </div>
  );
}

/**
 * Static stand-in with the loaded page's shape. No shimmer; blocks fill in
 * exactly once when the last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-muted" />
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-4 rounded-sm bg-muted/35" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="h-6 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <div className="h-7 w-28 rounded-lg bg-input/40" />
        </div>
        <div className="h-44 rounded-sm bg-muted/35" />
      </section>
    </>
  );
}
