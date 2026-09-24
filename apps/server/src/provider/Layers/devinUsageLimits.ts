import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const DEVIN_API_BASE = "https://api.devin.ai";
const API_KEY_ENV_NAMES = ["DEVIN_API_KEY", "DEVIN_PERSONAL_ACCESS_TOKEN"] as const;
const ORG_ENV_NAMES = ["DEVIN_ORG_ID", "DEVIN_ORGANIZATION_ID"] as const;

const AcuLimitItem = Schema.Struct({
  cycle_acu_limit: Schema.Number,
  scope: Schema.Literals(["enterprise", "org", "user"]),
  org_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const AcuLimitsPage = Schema.Struct({
  items: Schema.Array(AcuLimitItem),
  has_next_page: Schema.optional(Schema.Boolean),
  end_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const ConsumptionResponse = Schema.Struct({ total_acus: Schema.Number });

class DevinUsageApiForbidden extends Data.TaggedError("DevinUsageApiForbidden") {}
class DevinUsageApiError extends Data.TaggedError("DevinUsageApiError")<{
  readonly status: number;
}> {}

function envValue(
  environment: NodeJS.ProcessEnv,
  names: ReadonlyArray<string>,
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

const ensureOk = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  DevinUsageApiForbidden | DevinUsageApiError
> =>
  response.status === 401 || response.status === 403
    ? Effect.fail(new DevinUsageApiForbidden())
    : response.status < 200 || response.status >= 300
      ? Effect.fail(new DevinUsageApiError({ status: response.status }))
      : Effect.succeed(response);

/**
 * Devin's account usage is only reachable through the v3 enterprise API:
 * the CLI's interactive login token cannot read it, so a service-user or
 * personal-access credential plus the org id must be configured as provider
 * environment variables. The endpoint is Enterprise-plan only — Teams and
 * self-serve orgs get a 403.
 */
export const readDevinUsageLimits = Effect.fn("readDevinUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const apiKey = envValue(environment, API_KEY_ENV_NAMES);
  const orgId = envValue(environment, ORG_ENV_NAMES);
  if (apiKey === undefined || orgId === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        "Devin account usage needs DEVIN_API_KEY (or DEVIN_PERSONAL_ACCESS_TOKEN) and DEVIN_ORG_ID provider environment variables.",
    });
  }

  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    // Billing cycles close at midnight PST; derive the containing cycle by
    // shifting "now" into the fixed PST offset before reading its month.
    const now = yield* DateTime.now;
    const pacificNow = DateTime.subtract(now, { hours: 8 });
    const { year, month } = DateTime.toPartsUtc(pacificNow);
    const cycleStart = DateTime.makeUnsafe({ year, month, day: 1, hour: 8 });
    const cycleEnd = DateTime.add(cycleStart, { months: 1 });
    const startUnixSeconds = Math.floor(DateTime.toEpochMillis(cycleStart) / 1_000);
    const endUnixSeconds = Math.floor(DateTime.toEpochMillis(cycleEnd) / 1_000);

    const get = (path: string) =>
      client.execute(
        HttpClientRequest.get(`${DEVIN_API_BASE}${path}`).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.acceptJson,
        ),
      );

    const limitsPath = (after?: string) =>
      `/v3/enterprise/consumption/acu-limits/devin?first=50${
        after === undefined ? "" : `&after=${encodeURIComponent(after)}`
      }`;
    const limitsItems: Schema.Schema.Type<typeof AcuLimitItem>[] = [];
    const [limitsPage, consumptionBody] = yield* Effect.all(
      [
        get(limitsPath()).pipe(
          Effect.flatMap(ensureOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AcuLimitsPage)),
        ),
        get(
          `/v3/enterprise/consumption/daily/organizations/${encodeURIComponent(orgId)}?time_after=${startUnixSeconds}&time_before=${endUnixSeconds}`,
        ).pipe(
          Effect.flatMap(ensureOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ConsumptionResponse)),
        ),
      ],
      { concurrency: "unbounded" },
    );
    limitsItems.push(...limitsPage.items);
    let cursor = limitsPage.has_next_page ? (limitsPage.end_cursor ?? undefined) : undefined;
    while (cursor !== undefined) {
      const page = yield* get(limitsPath(cursor)).pipe(
        Effect.flatMap(ensureOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AcuLimitsPage)),
      );
      limitsItems.push(...page.items);
      cursor = page.has_next_page ? (page.end_cursor ?? undefined) : undefined;
    }

    const consumed = consumptionBody.total_acus;
    const orgLimit = limitsItems.find(
      (item) => item.scope === "org" && item.org_id === orgId,
    )?.cycle_acu_limit;

    if (orgLimit === undefined || orgLimit <= 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: `${consumed} ACUs consumed this cycle; no organization ACU limit is configured.`,
      });
    }

    const windows: ServerProviderUsageWindow[] = [
      {
        id: "acu_cycle",
        kind: "monthly",
        label: `ACUs (${consumed} / ${orgLimit})`,
        usedPercent: clampPercent((consumed / orgLimit) * 100),
        resetsAt: DateTime.formatIso(cycleEnd),
        windowDurationMins: Math.round(
          (DateTime.toEpochMillis(cycleEnd) - DateTime.toEpochMillis(cycleStart)) / 60_000,
        ),
      },
    ];
    return makeUsageLimits({ checkedAt, windows });
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("DevinUsageApiForbidden", () =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message:
            "Devin's consumption API requires an Enterprise plan and a credential with ViewAccountConsumption permission.",
        }),
      ),
    ),
    Effect.catch(() =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Devin could not read account usage limits.",
        }),
      ),
    ),
  );
});
