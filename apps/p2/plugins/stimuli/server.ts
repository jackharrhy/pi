// Persisted one-shot wakes: save immutable intent before dispatch, then reconcile native admission and settlement.
import { createHash } from "node:crypto";
import { obj, type Static } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import {
	awaitWithContext,
	type Ctx,
	defineFacet,
	defineState,
	forbidden,
	isChordError,
	isOwner,
	isWorker,
	record,
	signalOf,
	until,
} from "@p2/app/v1";
import { processLogs } from "@p2/app/v1/node";
import { Hosts, serverOf, WorkerInitValues } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { Shares } from "../sharing/contract.ts";
import { StimulusWorker, WakeSchema, WakeStore, Wakes } from "./contract.ts";

type Wake = Static<typeof WakeSchema>;
const Saved = defineState("p2.stimuli", {
	version: 1,
	schema: obj({ wakes: record(WakeSchema) }),
	initial: () => ({ wakes: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});

export default defineFacet((host) => {
	host.serve(WakeStore, (_params, self) => {
		const saved = self.state(Saved);
		const server = serverOf(self);
		const catalog = self.get(Catalog, {});
		const shares = self.get(Shares, {});
		const startValues = self.registry(WorkerInitValues);
		const startReady = self.derive([startValues], ([values]) => values.has("session"));
		const shared = (session: string) =>
			shares.links.value.some((link) => link.session === session) ||
			shares.people.value.some((person) => person.session === session);
		const active = new Map<string, Promise<void>>();
		const retry = new Map<string, { at: number; delay: number }>();
		let changed = () => {};
		self.on(saved, async () => changed());
		const blockUnavailable = async (ctx: Ctx) => {
			await saved.change((draft) => {
				for (const row of Object.values(draft.wakes)) {
					const target = catalog.sessions.value.find((session) => session.id === row.delivery.session);
					if (!target || (target.archivedAt === null && !shared(row.delivery.session))) continue;
					if (row.phase.kind === "scheduled") row.phase = { kind: "closed", reason: "blocked" };
					else if (row.phase.kind === "pending" || row.phase.kind === "uncertain")
						row.phase = { kind: "uncertain", policy: "readback-only" };
				}
			}, ctx);
			changed();
		};
		self.on(catalog.sessions, async (_change, ctx) => blockUnavailable(ctx));
		self.on(shares.links, async (_change, ctx) => blockUnavailable(ctx));
		self.on(shares.people, async (_change, ctx) => blockUnavailable(ctx));
		const phase = async (id: string, next: Wake["phase"], ctx: Ctx) => {
			await saved.change((draft) => {
				draft.wakes[id]!.phase = next;
				delete draft.wakes[id]!.lastError;
			}, ctx);
		};
		const reconcile = async (id: string, ctx: Ctx) => {
			let row = saved.value.wakes[id]!;
			const session = row.delivery.session;
			if ((await catalog.get({ id: session }, ctx)).archivedAt !== null) return;
			if (shared(session) && row.phase.kind === "scheduled") {
				await phase(id, { kind: "closed", reason: "blocked" }, ctx);
				return;
			}
			// Persisted overdue rows can run while plugins are still activating at server startup.
			await until(startReady, (ready) => ready, ctx);
			const worker = await awaitWithContext(ctx.get(StimulusWorker, { session }), ctx);
			if ((await catalog.get({ id: session }, ctx)).archivedAt !== null) return;
			row = saved.value.wakes[id]!;
			if (row.phase.kind === "closed" || row.phase.kind === "settled") return;
			const status = await worker.status({ id, intentHash: row.delivery.intentHash }, ctx);
			if (status.state === "conflict") throw new Error("Conflicting native wake receipt");
			if (status.state !== "missing") {
				await phase(
					id,
					status.state === "done" || status.state === "unanswered"
						? { kind: "settled", receipt: status.receipt, outcome: status.state }
						: { kind: "admitted", receipt: status.receipt },
					ctx,
				);
				return;
			}
			row = saved.value.wakes[id]!;
			if (row.phase.kind === "uncertain" && row.phase.policy === "readback-only") return;
			if (row.phase.kind === "admitted") throw new Error("Native wake receipt disappeared");
			if (row.phase.kind === "closed" || row.phase.kind === "settled") return;
			if (shared(session)) {
				await phase(
					id,
					row.phase.kind === "scheduled"
						? { kind: "closed", reason: "blocked" }
						: { kind: "uncertain", policy: "readback-only" },
					ctx,
				);
				return;
			}
			// Persist before RPC. Cancellation after this point cannot claim to undo admission.
			await saved.change((draft) => {
				const current = draft.wakes[id]!;
				if (
					current.phase.kind === "scheduled" ||
					(current.phase.kind === "uncertain" && current.phase.policy === "retry") ||
					current.phase.kind === "pending"
				)
					current.phase = { kind: "pending" };
			}, ctx);
			row = saved.value.wakes[id]!;
			if (row.phase.kind !== "pending") return;
			try {
				const result = await worker.admit(row.delivery, ctx);
				if (result.state === "conflict") throw new Error("Conflicting wake intent");
				await phase(id, { kind: "admitted", receipt: result }, ctx);
			} catch (error) {
				const current = saved.value.wakes[id]!.phase;
				await phase(
					id,
					{
						kind: "uncertain",
						policy: isChordError(error, "forbidden")
							? "readback-only"
							: current.kind === "uncertain"
								? current.policy
								: "retry",
					},
					ctx,
				);
				throw error;
			}
		};
		self.onLive(async (ctx) => {
			const signal = signalOf(ctx);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let wake = () => {};
			changed = () => wake();
			const abort = () => wake();
			signal.addEventListener("abort", abort);
			try {
				while (!signal.aborted) {
					const now = Date.now();
					let next = Infinity;
					const occupied = new Set(active.keys());
					for (const row of Object.values(saved.value.wakes).sort(
						(a, b) =>
							Number(a.phase.kind === "scheduled") - Number(b.phase.kind === "scheduled") ||
							a.delivery.notBefore - b.delivery.notBefore,
					)) {
						const { id, session, notBefore } = row.delivery;
						if (row.phase.kind === "closed" || row.phase.kind === "settled" || occupied.has(session)) continue;
						const target = catalog.sessions.value.find((entry) => entry.id === session);
						if (!target || target.archivedAt !== null) continue;
						const at = Math.max(notBefore, retry.get(id)?.at ?? 0);
						if (at > now) {
							if (row.phase.kind !== "scheduled") occupied.add(session);
							next = Math.min(next, at);
							continue;
						}
						occupied.add(session);
						// Independent targets do not wait for a stuck worker. The host context cancels every outstanding call.
						const attempt = server()
							.root((attemptCtx) => reconcile(id, attemptCtx), ctx)
							.catch(async (error: unknown) => {
								if (signal.aborted) return;
								await saved.change((draft) => {
									draft.wakes[id]!.lastError = error instanceof Error ? error.message : String(error);
								}, ctx);
							})
							.catch(() => {
								if (!signal.aborted)
									processLogs.append("stimuli", "error", "Could not persist wake reconciliation error");
							})
							.finally(() => {
								active.delete(session);
								// Back off recovery/status reads; this is not an admission deadline or an expiry.
								const delay = Math.min((retry.get(id)?.delay ?? 500) * 2, 60_000);
								retry.set(id, { at: Date.now() + delay, delay });
								changed();
							});
						active.set(session, attempt);
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
						if (signal.aborted) resolve();
						else if (next !== Infinity)
							timer = setTimeout(resolve, Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
					});
					clearTimeout(timer);
				}
			} finally {
				changed = () => {};
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				await Promise.allSettled(active.values());
			}
		});
		return {
			register: async ({ session, conversation, requestId, at, text }, ctx) => {
				if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at))
					throw new Error("at needs an ISO timestamp with an explicit UTC offset");
				const notBefore = Date.parse(at);
				if (!Number.isFinite(notBefore) || !formats["date-time"]!(at)) throw new Error("Invalid timestamp");
				const id = JSON.stringify([session, requestId]);
				const intentHash = createHash("sha256")
					.update(JSON.stringify([session, conversation, notBefore, text, "timer"]))
					.digest("hex");
				const previous = saved.value.wakes[id];
				if (previous) {
					if (previous.delivery.intentHash !== intentHash) throw new Error("Wake intent conflict");
					return previous;
				}
				if (notBefore <= Date.now()) throw new Error("New wakes must be in the future");
				if ((await catalog.get({ id: session }, ctx)).archivedAt !== null || shared(session))
					throw forbidden("Wakes require a private, unarchived session");
				const row: Wake = {
					delivery: { id, session, conversation, notBefore, text, intentHash },
					phase: { kind: "scheduled" },
				};
				await saved.change((draft) => {
					const existing = draft.wakes[id];
					if (existing && existing.delivery.intentHash !== intentHash) throw new Error("Wake intent conflict");
					if (!existing) draft.wakes[id] = row;
				}, ctx);
				return saved.value.wakes[id]!;
			},
			list: async ({ session }) =>
				Object.values(saved.value.wakes).filter((row) => row.delivery.session === session),
			cancel: async ({ session, id }, ctx) => {
				await saved.change((draft) => {
					const row = draft.wakes[id];
					if (!row || row.delivery.session !== session) throw new Error("No such wake");
					if (row.phase.kind === "scheduled") row.phase = { kind: "closed", reason: "cancelled" };
					else if (row.phase.kind === "pending" || row.phase.kind === "uncertain")
						row.phase = { kind: "uncertain", policy: "readback-only" };
				}, ctx);
				return saved.value.wakes[id]!;
			},
		};
	});
	host.serve(Wakes, (_params, principal, self) => {
		const store = self.get(WakeStore, {});
		if (isOwner(principal))
			return {
				variant: "owner",
				members: {
					registerTarget: (args, ctx) => store.register(args, ctx),
					listTarget: (args, ctx) => store.list(args, ctx),
					cancelTarget: (args, ctx) => store.cancel(args, ctx),
				},
			};
		if (!isWorker(principal)) throw forbidden("Wakes are private");
		const hosts = self.get(Hosts, {});
		const current = () => {
			const worker = hosts.workers.value[principal.session];
			if (!worker?.running || worker.generation !== principal.generation) throw forbidden("Stale worker");
		};
		return {
			variant: "worker",
			members: {
				register: (args, ctx) => {
					current();
					return store.register({ ...args, session: principal.session }, ctx);
				},
				list: (_args, ctx) => {
					current();
					return store.list({ session: principal.session }, ctx);
				},
				cancel: (args, ctx) => {
					current();
					return store.cancel({ ...args, session: principal.session }, ctx);
				},
			},
		};
	});
});
