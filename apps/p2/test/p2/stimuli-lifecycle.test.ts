// Controlled lost replies and a blocked route around production admission, backed by real Durable SQLite.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT, defineFacet, Session, signalOf } from "@p2/app/v1";
import { WorkerInitValues } from "@p2/app/v1/server";
import { createP2Models } from "../../plugins/models/models.ts";
import { Catalog, type Session as SessionRow } from "../../plugins/sessions/contract.ts";
import { Shares } from "../../plugins/sharing/contract.ts";
import { Admission, StimulusWorker, WakeStore } from "../../plugins/stimuli/contract.ts";
import serverFacet from "../../plugins/stimuli/server.ts";
import workerFacetPlugin from "../../plugins/stimuli/worker.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { openHostStore } from "../../src/runtime/host-dirs.ts";
import { SERVER } from "../../src/runtime/principals.ts";
import type { HarnessParts } from "../../src/runtime/worker.ts";
import { APP, memoryLinkPair, poll, testHost, workerFacet } from "./helpers.ts";

const TEST = BACKGROUND_CONTEXT;
it("keeps a cancelled lost admission readback-only, recovers its native receipt, and does not stall another target", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-stimuli-fault-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const durableCtx = durableContext(new AbortController().signal);
	const durable = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{
			models: createP2Models(true),
			registry: createRegistry(),
		},
		durableCtx,
	);
	t.after(() => durable.close(durableCtx));
	await durable.root(durableCtx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });
	const actual = await testHost({
		kind: "worker",
		address: Session({ id: "lost" }),
		facets: [
			workerFacet({
				harness: { durable, environments: {}, relocate: async () => {} } as unknown as HarnessParts,
				worker: {
					init: {
						app: APP,
						dataDir: directory,
						fake: true,
						telemetry: false,
						generation: 1,
						values: {
							session: {
								id: "lost",
								cwd: directory,
								model: { provider: "faux", modelId: "faux-1" },
								thinkingLevel: "off",
							},
						},
					},
				},
			}),
			workerFacetPlugin,
		],
	});
	t.after(() => actual.close());
	let admitCalls = 0;
	let hide = true;
	let releaseReadback = () => {};
	const readbackEntered = Promise.withResolvers<void>();
	const proxy = await testHost({
		kind: "worker",
		address: Session({ id: "lost" }),
		facets: [
			defineFacet((host) => {
				host.serve(StimulusWorker, (_params, _principal, _self) => ({
					variant: "server",
					members: {
						admit: async (delivery) => {
							admitCalls++;
							await actual.root(async (ctx) => (await ctx.get(Admission, {})).admit(delivery, ctx));
							throw new Error("Reply lost after native commit");
						},
						status: async (key, ctx) => {
							if (admitCalls > 0 && hide) {
								readbackEntered.resolve();
								await new Promise<void>((resolve) => {
									releaseReadback = resolve;
								});
								if (signalOf(ctx).aborted) throw signalOf(ctx).reason;
								return { state: "missing" as const };
							}
							return actual.root(async (local) => (await local.get(Admission, {})).status(key, local));
						},
					},
				}));
			}),
		],
	});
	t.after(() => {
		releaseReadback();
		return proxy.close();
	});
	const gate = Promise.withResolvers<void>();
	let blockedStarted = false;
	const rows: SessionRow[] = ["lost", "blocked"].map((id) => ({
		id,
		cwd: directory,
		title: id,
		createdAt: 1,
		updatedAt: 1,
		archivedAt: null,
		pinned: false,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		main: 1,
		branches: [],
	}));
	let link: ReturnType<typeof memoryLinkPair>[0] | undefined;
	let store = await openHostStore(join(directory, "server"), { outbox: false }, TEST);
	t.after(() => store.close(TEST));
	const openServer = () =>
		testHost({
			store,
			facets: [
				defineFacet((_host, self) => {
					self.contribute(WorkerInitValues, { session: async () => ({}) });
				}),
				serverFacet,
			],
			stubs: [
				[
					Catalog,
					(_params, _principal, self) => ({
						sessions: self.state(rows),
						get: async ({ id }: { id: string }) => rows.find((row) => row.id === id)!,
						create: async () => {
							throw new Error("unused");
						},
						activity: async () => null,
						update: async () => {
							throw new Error("unused");
						},
					}),
				],
				[
					Shares,
					(_params, _principal, self) => ({
						links: self.state([]),
						people: self.state([]),
						emails: self.state([]),
						authenticate: async () => null,
						authenticateEmail: async () => null,
						grant: async () => null,
						active: async () => null,
						link: async () => null,
						share: async () => null,
						remove: async () => null,
						join: async () => {
							throw new Error("unused");
						},
					}),
				],
			],
			beforeLoad: (host) =>
				host.route(
					Session,
					{
						authorize: () => true,
						resolve: async (address) => {
							if (address.params.id === "blocked") {
								blockedStarted = true;
								await gate.promise;
								throw new Error("blocked route ended");
							}
							if (!link) {
								const [down, up] = memoryLinkPair();
								proxy.host.connect(up, { principal: SERVER }, TEST);
								link = down;
							}
							return { link, principal: { kind: "worker", session: "lost", generation: 1 } };
						},
					},
					TEST,
				),
		});
	let server = await openServer();
	t.after(() => {
		gate.resolve();
		return server.close();
	});
	const restart = async () => {
		gate.resolve();
		await server.close();
		await store.close(TEST);
		link = undefined;
		store = await openHostStore(join(directory, "server"), { outbox: false }, TEST);
		server = await openServer();
	};
	const register = (session: string, requestId: string) =>
		server.root(async (ctx) =>
			(await ctx.get(WakeStore, {})).register(
				{
					session,
					conversation: 1,
					requestId,
					at: new Date(Date.now() + 100).toISOString(),
					text: "fault wake",
				},
				ctx,
			),
		);
	const blocked = await register("blocked", "blocked");
	const lost = await register("lost", "lost");
	await poll(() => admitCalls > 0, 5000, "admission attempt");
	await readbackEntered.promise;
	assert(blockedStarted, "the stuck route is genuinely in flight while another target admits");
	await server.root(async (ctx) => {
		const wakes = await ctx.get(WakeStore, {});
		const cancelled = await wakes.cancel({ session: "lost", id: lost.delivery.id }, ctx);
		assert.deepEqual(cancelled.phase, { kind: "uncertain", policy: "readback-only" });
	});
	releaseReadback();
	await poll(async () =>
		server.root(async (ctx) => {
			const row = (await (await ctx.get(WakeStore, {})).list({ session: "lost" }, ctx))[0]!;
			return row.phase.kind === "uncertain";
		}),
	);
	assert.equal(admitCalls, 1, "missing readback does not authorize retry after cancellation");
	await restart();
	await server.root(async (ctx) => {
		const row = (await (await ctx.get(WakeStore, {})).list({ session: "lost" }, ctx))[0]!;
		assert.deepEqual(row.phase, { kind: "uncertain", policy: "readback-only" });
	});
	hide = false;
	releaseReadback();
	await poll(async () =>
		server.root(async (ctx) =>
			["admitted", "settled"].includes(
				(await (await ctx.get(WakeStore, {})).list({ session: "lost" }, ctx))[0]!.phase.kind,
			),
		),
	);
	await restart();
	const conversation = await durable.root(durableCtx);
	await conversation.abort(durableCtx);
	await poll(async () =>
		server.root(
			async (ctx) =>
				(await (await ctx.get(WakeStore, {})).list({ session: "lost" }, ctx))[0]!.phase.kind === "settled",
		),
	);
	assert.equal(admitCalls, 1);
	assert.equal(blocked.delivery.session, "blocked");
});
