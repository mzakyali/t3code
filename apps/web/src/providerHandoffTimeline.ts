/**
 * Timeline side of provider handoff: decoding the `provider.handoff` /
 * `provider.handoff.failed` activities and shaping their dedicated card.
 * The implementation lives in client-runtime so mobile renders identical
 * cards; this module keeps web imports and its decode/card-model tests on
 * the original path.
 *
 * @module providerHandoffTimeline
 */
export {
  decodeProviderHandoffInfo,
  providerHandoffCardModel,
  type ProviderHandoffCardModel,
  type ProviderHandoffInfo,
} from "@t3tools/client-runtime/work-log/provider-handoff";
