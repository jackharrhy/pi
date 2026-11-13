// The session worker owns receipts and admits native follow-ups in the same Durable commit.
import { defineDoc } from "@earendil-works/pi-durable";
import type { Static } from "@earendil-works/pi-schema";
import { defineFacet, forbidden, PEER_MESSAGE_ENTRY, type PeerMessage, senderText } from "@p2/app/v1";
import { harnessOf, InputGates, mainConversation, workerOf } from "@p2/app/v1/worker";
import { ExternalIngress, type ReceiptSchema } from "./contract.ts";

type Receipt = Static<typeof ReceiptSchema>;
const Receipts = defineDoc<{ events: Record<string, Receipt> }>({
	kind: "p2.ingress-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ events: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});

export default defineFacet((host) => {
	host.serve(ExternalIngress, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server ingress only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const gates = self.registry(InputGates);
		return {
			variant: "server",
			members: {
				admit: ({ sender, name, eventId, text, contentHash }, ctx) =>
					worker().liveness.call(async () => {
						for (const gate of gates.value.values()) await gate(ctx);
						const durable = harness().durable;
						const main = await durable.conversation(await mainConversation(durable, ctx), ctx);
						if (!main) throw new Error("No main conversation");
						const key = JSON.stringify([sender, eventId]);
						const conflict = await durable.commit(async (tx) => {
							const doc = await tx.doc(Receipts);
							const previous = doc.events[key];
							if (previous) return previous.contentHash !== contentHash;
							// Native admission must precede table writes; merely opening a document draft above writes nothing.
							const submissionId = await main.submit(tx, {
								type: "input",
								content: [
									{ type: "text", text: senderText({ kind: "external", id: sender, name }) },
									{ type: "text", text },
								],
								entry: {
									kind: PEER_MESSAGE_ENTRY,
									data: {
										from: { kind: "external", id: sender, title: name },
										text,
									} satisfies PeerMessage,
								},
								requestId: `ingress:${key}`,
								whenBusy: "followUp",
							});
							const receipt: Receipt = { state: "admitted", eventId, contentHash, submissionId };
							doc.events[key] = receipt;
							return false;
						}, ctx);
						if (conflict) return { state: "conflict" as const };
						const saved = await durable.snapshot(Receipts, ctx);
						return saved!.events[key]!;
					}),
				receipt: ({ sender, eventId }, ctx) =>
					worker().liveness.call(async () => {
						const doc = await harness().durable.snapshot(Receipts, ctx);
						return doc?.events[JSON.stringify([sender, eventId])] ?? null;
					}),
			},
		};
	});
});
