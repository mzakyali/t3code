import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { readDevinUsageLimits } from "./devinUsageLimits.ts";

const devinEnvironment = {
  DEVIN_API_KEY: "cog_service-token",
  DEVIN_ORG_ID: "org-123",
};

const jsonClient = (
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
  );

const limitsPage = (
  items: ReadonlyArray<{ cycle_acu_limit: number; scope: string; org_id?: string }>,
  options?: { readonly hasNextPage?: boolean; readonly endCursor?: string },
) =>
  Response.json({
    items,
    has_next_page: options?.hasNextPage ?? false,
    end_cursor: options?.endCursor ?? null,
    total: items.length,
  });

const consumptionBody = (totalAcus: number) =>
  Response.json({ total_acus: totalAcus, consumption_by_date: [] });

const provideClient = <A, E, R>(effect: Effect.Effect<A, E, R>, client: HttpClient.HttpClient) =>
  effect.pipe(Effect.provideService(HttpClient.HttpClient, client));

it.effect("reports unsupported without making requests when credentials are not configured", () =>
  Effect.gen(function* () {
    const client = HttpClient.make(() => Effect.die("must not request usage without credentials"));
    for (const environment of [
      {},
      { DEVIN_API_KEY: "cog_token-only" },
      { DEVIN_ORG_ID: "org-only" },
      { DEVIN_API_KEY: "   ", DEVIN_ORG_ID: "org-123" },
    ]) {
      const limits = yield* provideClient(readDevinUsageLimits(environment), client);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("DEVIN_API_KEY");
    }
  }),
);

it.effect("maps org ACU consumption into a monthly window", () =>
  Effect.gen(function* () {
    const requestedUrls: string[] = [];
    const client = jsonClient((request) => {
      requestedUrls.push(request.url);
      expect(request.headers.authorization).toBe("Bearer cog_service-token");
      if (request.url.includes("/acu-limits/devin")) {
        expect(request.url).toContain("first=50");
        return limitsPage([
          { cycle_acu_limit: 500, scope: "enterprise" },
          { cycle_acu_limit: 50, scope: "user" },
          { cycle_acu_limit: 999, scope: "org", org_id: "org-other" },
          { cycle_acu_limit: 100, scope: "org", org_id: "org-123" },
        ]);
      }
      expect(request.url).toContain("/consumption/daily/organizations/org-123");
      expect(request.url).toMatch(/time_after=-?\d+/);
      expect(request.url).toMatch(/time_before=-?\d+/);
      return consumptionBody(25);
    });

    const limits = yield* provideClient(readDevinUsageLimits(devinEnvironment), client);
    expect(limits.unavailable).toBeUndefined();
    expect(requestedUrls).toHaveLength(2);
    const window = limits.windows[0];
    expect(window?.kind).toBe("monthly");
    expect(window?.label).toContain("25 / 100");
    expect(window?.usedPercent).toBe(25);
    // The test clock sits at the epoch, so the containing PST-bounded cycle is
    // Dec 1 1969 08:00 UTC through Jan 1 1970 08:00 UTC.
    expect(window?.resetsAt).toBe("1970-01-01T08:00:00.000Z");
    expect(window?.windowDurationMins).toBe(31 * 24 * 60);
  }),
);

it.effect("follows ACU limit pagination to find the org scope", () =>
  Effect.gen(function* () {
    const client = jsonClient((request) => {
      if (request.url.includes("/acu-limits/devin")) {
        if (request.url.includes("after=cursor-2")) {
          return limitsPage([{ cycle_acu_limit: 80, scope: "org", org_id: "org-123" }]);
        }
        return limitsPage([{ cycle_acu_limit: 500, scope: "enterprise" }], {
          hasNextPage: true,
          endCursor: "cursor-2",
        });
      }
      return consumptionBody(40);
    });

    const limits = yield* provideClient(readDevinUsageLimits(devinEnvironment), client);
    expect(limits.windows[0]?.usedPercent).toBe(50);
  }),
);

it.effect("accepts the alternate credential environment variables", () =>
  Effect.gen(function* () {
    const client = jsonClient((request) => {
      expect(request.headers.authorization).toBe("Bearer pat_personal-token");
      return request.url.includes("/acu-limits/devin")
        ? limitsPage([{ cycle_acu_limit: 200, scope: "org", org_id: "org-9" }])
        : consumptionBody(10);
    });
    const limits = yield* provideClient(
      readDevinUsageLimits({
        DEVIN_PERSONAL_ACCESS_TOKEN: "pat_personal-token",
        DEVIN_ORGANIZATION_ID: "org-9",
      }),
      client,
    );
    expect(limits.windows[0]?.usedPercent).toBe(5);
  }),
);

it.effect("treats 401 and 403 as unsupported plan or permission", () =>
  Effect.gen(function* () {
    for (const status of [401, 403]) {
      const client = jsonClient(() => new Response(null, { status }));
      const limits = yield* provideClient(readDevinUsageLimits(devinEnvironment), client);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("Enterprise");
    }
  }),
);

it.effect("reports server errors and malformed payloads as probeFailed", () =>
  Effect.gen(function* () {
    const failing = yield* provideClient(
      readDevinUsageLimits(devinEnvironment),
      jsonClient(() => new Response(null, { status: 500 })),
    );
    expect(failing.unavailable?.reason).toBe("probeFailed");

    const malformed = yield* provideClient(
      readDevinUsageLimits(devinEnvironment),
      jsonClient((request) =>
        request.url.includes("/acu-limits/devin")
          ? Response.json({ unexpected: true })
          : consumptionBody(10),
      ),
    );
    expect(malformed.unavailable?.reason).toBe("probeFailed");
  }),
);

it.effect("reports consumption without a configured org limit as unsupported", () =>
  Effect.gen(function* () {
    const client = jsonClient((request) =>
      request.url.includes("/acu-limits/devin")
        ? limitsPage([
            { cycle_acu_limit: 500, scope: "enterprise" },
            { cycle_acu_limit: 60, scope: "user" },
            { cycle_acu_limit: 999, scope: "org", org_id: "org-other" },
          ])
        : consumptionBody(42),
    );
    const limits = yield* provideClient(readDevinUsageLimits(devinEnvironment), client);
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits.unavailable?.message).toContain("42 ACUs consumed this cycle");
  }),
);
