# Review usage

The Usage page combines Codex, Claude Code, Grok Build, and Devin ACP activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Devin ACP records come from canonical T3 provider event logs and cover sessions driven through the
selected T3 server. Use the provider filter above the breakdown to focus the chart and tables, and
use the download button to export the current window as CSV. The page can optionally show official
Devin organization ACUs in a separate section when a `cog_...` service key with
`ViewOrgConsumption` permission and `DEVIN_ORG_ID` are configured on the server; ACUs are never
combined with token-cost estimates. The normal CLI login is not an account-usage credential.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

The context meter beside the composer shows the active provider's current window percentage and
token counts when that provider reports them.
