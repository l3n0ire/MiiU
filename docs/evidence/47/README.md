# Hidden Pass sharing-OFF regression evidence

## Released real-model test, before this patch

Source main: `60cb3792fe2250ce7e7badb233c73c1bb39c9014`. Actual OpenAI `gpt-6-luna`, unchanged Expedition, PassMinds and createJsonCaller, seed 7. Same layout; 20 aggregate choices per run; 2,000 output-token bound per request. All 38 requests returned HTTP 200 / valid JSON. No retries or built-in fallbacks.

| Sharing | Outcome | Calls | Input tokens | Output tokens | Token cost at standard rates |
| --- | --- | --- | --- | --- | --- |
| ON | 4/4 delivered; Marlo discovered and chose share | 18 | 10,266 | 1,902 | $0.0019776 |
| OFF | Budget failure at 1/4; only Marlo knew | 20 | 11,866 | 2,247 | $0.0023101 |

Total calculated token cost: $0.0042877 at $0.10/M input and $0.50/M output. Output includes reasoning tokens. Not a billing-invoice measurement.

OFF returned 11 share choices, all correctly blocked. Its discoverer prompt still invited sharing despite the action list hiding it. This contradictory instruction confounds the comparison. No benefit/speedup conclusion is supported. ON sharing happened before crate fetches, so no mid-route replan was observed. Paths, walking, pickup and delivery are engine code, not model reasoning. This is one stochastic run per condition, not a controlled experiment.

## Patch evidence: scripted mock only

The two PNGs and MP4 here are **local scripted mock responses**, not a paid model rerun or deployed-state proof. Current patch build, seed 7, sharing OFF, 60-choice budget, 4x game speed. Pip scouts, learns privately, fetches via his pass; the others use public routes. Completion is 4/4, 18 calls in this script. The UI names the provider `mock-evidence`.

Pixels inspected: OFF label, private-discovery feed attribution, map, and completion banner are readable; feed clips older lines at the top as it scrolls. This patch has no layout changes. Automated regressions inspect the actual prompt strings, assert OFF never invites share, preserve ON choice, and keep the private location out of ignorant prompts. Scripted completion does not establish post-patch real-model behavior.
