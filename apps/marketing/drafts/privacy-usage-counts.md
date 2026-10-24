<!--
DRAFT, not published. A section for the privacy policy, to go live with the
first counted experimental feature (phase 2 of usage counts). Source: the
approval record .product/approved/experimental-telemetry/ (approval.md
overrides SPEC.md: counts are on by default when a person turns on an
experimental feature, with a notice; no install id). The owner was advised a
lawyer may check this before launch: the strict EU reading of GDPR and
ePrivacy asks for opt-in.
This folder is outside src/, so Astro does not build it.
-->

## Experimental features and usage counts

Plannotator has experimental features. Each one stays off until you turn it on.

When you turn on an experimental feature, Plannotator also counts how often you use that feature. You can turn these counts off. The notice that opens when you turn the feature on says so, and it tells you how to turn them off.

**What is sent.** At most once a day, your computer sends our server a short list of whole numbers for one feature and one complete day. For example: "opened 3 times, answered 14 questions". The request also carries:

- the date in UTC;
- the feature's version number;
- two facts worked out on your computer: whether this was the first day you used the feature (sent once), and how many of the last 7 days you used it, as a range (1, 2–3, 4–5 or 6–7).

Each number is capped at 100 a day. The notice lists every count for the feature before it starts. Run `plannotator telemetry --show` to see exactly what would be sent.

**What is never sent.** Your questions, answers, messages, files, code, paths, project or repository names, agent names, or any id for you or your computer. Plannotator sends no install id, so two days of counts from your computer cannot be linked. The sender is the Plannotator program on your computer, never your browser.

**Where it goes.** The counts go to our server on Cloudflare (counts.plannotator.ai). The server adds your numbers to daily totals across everyone and keeps only those totals. It does not store your IP address, the time of your request, or a record per person or per computer. Cloudflare runs the server, so it sees your IP address while it delivers the request, as it does for any website, under its data processing terms. We call the totals anonymous at rest. They are not anonymous in transit.

**How long we keep it.** Counting for each feature stops on a fixed date, shown in `plannotator telemetry --show`. We delete a feature's totals 180 days after that date, and never keep any total longer than 400 days. Totals for a day with fewer than 5 reporting computers are never shown, not even to us through the read interface.

**How to stop.** Run `plannotator telemetry --off`, or set `PLANNOTATOR_TELEMETRY=0` or `DO_NOT_TRACK=1`. Turning the feature off also stops its counts. In each case, counts not sent yet are deleted from your computer. `plannotator uninstall --purge` removes them too. We hold no identifier, so we cannot find or delete totals you already sent. They cannot be traced back to you.
