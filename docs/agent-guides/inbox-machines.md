## Inbox: linked machines

One Inbox across machines, Phase 1, the server engine. The design and the formal model live outside the repo (`.ops/multi-machine/PLAN.md`, `model/FINDINGS.md`); this guide is what is built. The window's side (labels, the machine filter, "offline since", "Will send when … is back") is not built yet.

**The shape.** Every machine keeps its own Inbox, exactly as before: its agents, files, wakes and offline behavior do not change. There is no home machine and no machine is special. One pairing code links two Inboxes both ways, and each then shows every machine's threads. A thread lives only on the machine whose agent started it; every other Inbox is a view of it and a remote control. No Inbox stores another's threads on disk, and no Inbox passes one machine's data on to a third.

**Files** (`packages/server/`), one job each:
- `inbox-machines.ts`: the coordinator. Linking and unlinking, the merged view, the forward, the window's and the CLI's routes, and the two door routes only a machine calls. Nothing else in the route table knows about links.
- `inbox-links.ts`: the one place linking state lives, `inbox/machines.json` (0600, temp file then rename): `{ v: 1, self: { id }, links: [{ id, name, token, transport, device_id, linked_at }] }`. `self.id` is this Inbox's stable id (`ibx_…`), made once and served by `health`; links key on it, never on an address. A link to an id already linked replaces it; a link to this Inbox's own id is refused (`link_to_self`). Also the pairing link format.
- `inbox-peer-link.ts`: one live link per machine (`PeerLink`).
- `inbox-outbox.ts`: the outbox and its rules.
- `inbox-transport.ts`: the transport seam, two calls (one request to the door, its event stream). `inbox-transport-tailnet.ts`: the one transport, HTTPS over the tailnet to the other Inbox's door (`https://<MagicDNS name>:8443/api/inbox/device/*`, Tailscale's real certificate). Plain `http://` is taken only for a loopback host (two Inboxes on one computer, as the tests run them). A later transport (the relay, or a server reachable only over SSH) is one more file and one more `kind`; SSH between peers is out by design (laptops have no sshd and sit behind NAT).

**The door, with Phones off** (`inbox-devices.ts`). A linked Inbox is a device with platform `machine`, redeemed from a machine offer (its own slots, the same limits as a phone's: 10 minutes, 5 wrong codes). This works with `PLANNOTATOR_INBOX_PHONES` off: the door then answers only a machine's token (a revoked one gets `401 device_revoked`), `pair` only while a machine offer is open, and to anything else it is the unknown-route 404 it always was. The tailnet door (8443) publishes at start only while a machine is linked; phone pairing, the Wi-Fi listener, the relay and the phone routes stay off. A machine device never gets relay carriage or pushes. Two door routes take only a machine: `link-back` and `unlink`. A machine asking for the merged view (`machines=1`, on any route) is `403 machines_view_refused`. On Linux, a failing `tailscale serve` says to run `sudo tailscale set --operator=$USER` once.

**Linking both ways.** On the machine being linked, `plannotator inbox link --offer [--tailscale]` (or `POST /api/inbox/machines/offer`) prints `plannotator://link?v=1&id=&name=&tailnet=&secret=&code=`; `--tailscale` first publishes the door on the tailnet so the code carries its address. On the other machine, `plannotator inbox link <code> [--address <host:port>] [--back <host:port>] [--one-way]`:
1. It redeems the code at the far door as `platform: "machine"` and reads the far `health` with the new token: its `inbox_id` must match the code's `id`, must not be this Inbox's own, and `machine_links` must be at least 1 (else `machine_needs_update`).
2. It opens a machine offer on its own door and hands it to the far Inbox through `link-back`; the far Inbox redeems it the same way and saves its link. The way back is `--back`, else this Inbox's tailnet door address; with neither, the link is refused (`no_way_back`) unless `--one-way`.
3. When the way back fails, the far device is removed (`unlink`) and nothing is saved.

**Unlink removes both sides** (rule 13). `plannotator inbox unlink <name or id>` (or `POST /api/inbox/machines/:id/unlink`) tells the other Inbox through its door's `unlink` (5 s), then forgets the link here: the PeerLink stops, the other machine's device on this door is revoked, and every write held for it ends with a notice. When the other machine cannot be reached, it learns at its next contact: its link gets `401 device_revoked`, and it forgets this side the same way, revoking this Inbox's token there.

**A link's line** (`PeerLink`). It dials the far door's `health` with its token, then holds the far event stream from its cursor (`Last-Event-ID`). States: `connecting`, `online`, `offline` (since when, and why), `needs_update` (its version), `revoked`. Only `401 device_revoked` (or an unknown token) stops a link; every other failure redials, 250 ms doubling to 30 s, at once when a timer fires far past its time (the computer slept) or the person acts on that machine (a read or a write through the forward). 20 s with no byte on the stream (the door sends a heartbeat every 15 s) is a dead line. The far list is kept in memory only, refreshed after each record with one fetch in flight at a time, and a list older (by cursor) than the one held is dropped. A machine that goes offline keeps its rows in the merged view from that memory; when the viewing Inbox restarts while the other machine is away, its rows come back when that machine does (accepted: no copy on disk). Records at or before the stream's hello cursor are a resync, marked `live: false`, never a notification. The outbox is sent when the stream says hello and after any request that reached the machine.

**Merged data only on request.** Every existing route stays this Inbox's own. The window asks with `machines=1`:
- `GET /api/inbox/threads?machines=1`: the sections computed over this Inbox's rows and every linked machine's, each row with `machine` (its `ibx_` id); `projects` from every machine, each with `machine`; plus `self` and `machines`. `?project=` takes another machine's project id here.
- `GET /api/inbox/events?machines=1`: the local stream unchanged, plus frames that never carry an `id:` (the local seq and `Last-Event-ID` stay this Inbox's): `machines` (`{ machines }`, a snapshot when the stream opens and on every change), `machine` (`{ machine, seq, live, record }`, a far record with that machine's own seq; `live: false` for a resync), `outbox` (an entry, on every change).
- The door refuses `machines=1` to a machine, so two Inboxes linked both ways cannot echo each other: echo is impossible by construction, not by a per-handler check.
- `GET /api/inbox/sessions` carries `machine`.

**The forward**, `/api/inbox/m/<machine>/<door route>`. Generic: it forwards any route and the far door decides what is allowed (`404 device_route_not_found` otherwise), so a route added to the door later works across machines with nothing changed here. `events`, `pair`, `link-back`, `unlink` and `revoke` are not forwarded.
- A GET passes through (of the window's headers only `Range`, `If-Range`, `If-None-Match`; the answer's status, body and content headers unchanged). Unreachable: `503 machine_offline` with the machine's state.
- A JSON POST goes through the outbox, online or not: one path. This Inbox's `serverSession` is checked here and stripped. It waits up to 4 s (`MACHINE_WRITE_WAIT_MS`) while the machine is online: the far answer, status and body as its door gave them (`X-Plannotator-Outbox: delivered | refused`; `Idempotent-Replayed: true` for a key seen before). Otherwise `202 { outbox, machine }`: "Sending…", or "Will send when … is back" when it is offline.
- A reply (`messages/:id/reply`) must carry `seen_through_seq`, the `cursor` of the thread read the person saw (`422` without it).
- Any other POST (an upload, a drawing) is never held: it streams through while the machine is online, `503 machine_offline` otherwise.

**The outbox** (`inbox-outbox.ts`), on the Inbox where the person pressed Send: `inbox/outbox/<machine id>.jsonl`, 0600, append-only, each line a full snapshot of one entry (the last line per key wins, a torn last line is skipped); compaction at start writes a temp file and renames it. One sender loop per machine, oldest first, one request at a time. Entry states: `queued` (never left), `sending` (a request left, no answer yet), `delivered` (2xx), `refused` (4xx), `parked` (5xx five times in a row), `dropped` (the link went). Only small JSON is held (256 KB). Settled entries are kept 7 days so a retried Send answers them; notices nobody dismissed, 30 days. The rules, each with its code and test:

| Rule | In code | Test |
| --- | --- | --- |
| 1 One key end to end: the window's key; every outcome kept per key, refusals included | `submit` | `inbox-outbox.test.ts` rule 1; e2e 2 and 3 (a retried Send answers the same reply) |
| 2 One queue per machine (stronger than per thread): each waits for the one before it | `drain` | rule 2 (order, one at a time, an online Send never overtakes a held one) |
| 3 Refused answers leave, with a notice | `settle`, `classifyAnswer` | rule 3 |
| 4 Unlink and revoke empty that machine's queue: "not delivered", or "may have been delivered" | `dropMachine` | rule 4; e2e 6 |
| 5 The list only moves forward | `PeerLink.acceptList`, `refreshList` | `inbox-peer-link.test.ts` "the list" |
| 6 A restart shows a sleeping machine's rows when it wakes (no copy on disk) | `PeerLink.list` in memory | e2e 3 (rows stay while B is down, from memory) |
| 7 Written atomically | append-only lines, `compact` | rule 7 (on disk before submit returns, torn line, temp and rename) |
| 8 Every forwarded write dedupes in the owner's store, or is a set-state | `DOOR_WRITES` | rule 8 (a door write with no entry fails) |
| 9 A machine reads only local data | the door refuses `machines=1` to a machine | e2e 5 |
| 10 A request that has left is never "not sent" | `left` written before the request | rule 10 |
| 11 A held reply carries what the person saw; a late one is refused | `seen_through_seq`, `replyIsStale` (the reply route, `409 thread_moved_on`) | rule 11; e2e 4 |
| 12 "Sending…" until the owner answers | states, `202` | rule 12; e2e 3 |
| 13 Unlink removes both links and revokes on the far side | `unlink`, `unlinkedBy`, `onRevoked` | e2e 6 |
| 15 Flush on hello and after any request that reached the machine | `PeerLink.flush` | `inbox-peer-link.test.ts` rule 15 |
| 16 A stalled stream is a dead line | the 20 s watchdog | `inbox-peer-link.test.ts` rule 16 |
| 17 Only `device_revoked` stops a link; a 5xx is parked after five | `classifyAnswer`, `OUTBOX_MAX_SERVER_ERRORS` | rule 17 |
| 19 Links keyed by Inbox id; a link to self refused | `InboxLinks.put` | `inbox-links.test.ts` |
| 21 A resync is never news | `live: false` | `inbox-peer-link.test.ts` rule 21; e2e 2 (`live: true` for the new question) |

**Known gap (accepted for Phase 1).** A held answer and its later notice exist only on the Inbox that holds it. Another machine's window does not show that an answer is waiting there.

**Routes** (window routes behind the window's guards; linking and unlinking answer only on this computer, `403 local_only` through the tailnet):
- `GET /api/inbox/machines`: `{ self, machines: [{ id, name, self, state, since, reason, version, address, both_ways, waiting }] }`.
- `POST /api/inbox/machines/offer` `{ serverSession?, tailscale? }`: `201 { link, code, expires_at, machine, tailnet, tailnet_error }`.
- `POST /api/inbox/machines/link` `{ serverSession?, link | code, address?, back?, one_way? }`: `201 { machine }`; refusals `offer_expired`, `pairing_code_wrong`, `machine_unreachable`, `machine_needs_update`, `machine_mismatch`, `link_to_self`, `no_way_back`.
- `POST /api/inbox/machines/:id/unlink` `{ serverSession? }`: `{ unlinked, told }`.
- `GET /api/inbox/outbox[?machine=]`: `{ waiting, notices }`; `POST /api/inbox/outbox/:key/dismiss`.
- `/api/inbox/m/<machine>/<door route>`: the forward.
- The CLI's control routes (the registry's bearer token): `GET /api/inbox/control/machines`, `POST /api/inbox/control/machines/offer | link | unlink` (`unlink` takes `{ machine }`, a name or id).
- `health` adds `inbox_id`, `machine_links` (the protocol, 1) and `routes` (the door's routes in words).

**Proofs.**
- `packages/server/inbox-machines.test.ts`: three real Inboxes (`plannotator inbox --background`, each its own temp HOME and data dir, Phones off, `PLANNOTATOR_INBOX_CONNECT=0`, `PLANNOTATOR_UPDATE_CHECK=0`, no browser) linked through the real CLI pairing, the tailnet transport pointed at the other Inbox's loopback port. A `tailscale` stand-in on PATH records any call, and the test asserts none happened. An agent on B asks and waits (`wait_for_reply` over MCP); A's merged list and stream show it; the person answers from A through the forward and B's agent wakes. B's Inbox killed: offline, rows kept, the answer held (`202`), B started again, the answer delivered exactly once and the agent woken. Late words refused (rule 11). No echo with C linked to B only, through a resync both ways; a machine token asking `machines=1` is refused. Unlink both up, and with B asleep (B cleans up at its next contact; both tokens revoked).
- `inbox-outbox.test.ts` (the rules, module alone), `inbox-peer-link.test.ts` (the line against a stand-in door), `inbox-links.test.ts`.
