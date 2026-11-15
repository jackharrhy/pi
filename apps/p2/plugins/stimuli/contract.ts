// Worker-owned admission and receipt recovery for immutable external deliveries.
import { arr, int, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, param, remote, serverHost, sessionHost } from "@p2/app/v1";

// Keep the legacy wire shape structural here: copied plugin contracts cannot import a third plugin.
const EventIdSchema = str({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
const ReceiptSchema = obj({
	state: literal("admitted"),
	eventId: EventIdSchema,
	contentHash: str(),
	submissionId: int(),
});

const LegacyArgs = obj({ sender: str(), name: str(), eventId: EventIdSchema, text: str(), contentHash: str() });
const LegacyKey = obj({ sender: str(), eventId: EventIdSchema });
const Conflict = obj({ state: literal("conflict") });
export const DeliverySchema = obj({
	id: str(),
	session: str(),
	conversation: int(),
	notBefore: int(),
	text: str(),
	intentHash: str(),
});
export const DeliveryReceiptSchema = obj({
	state: literal("admitted"),
	deliveryId: str(),
	intentHash: str(),
	conversation: int(),
	submissionId: int(),
});
const DeliveryResult = union([DeliveryReceiptSchema, Conflict]);
const DeliveryStatus = union([
	obj({ state: literal("missing") }),
	obj({ state: literal("conflict") }),
	obj({ state: literal("queued"), receipt: DeliveryReceiptSchema }),
	obj({ state: literal("placed"), receipt: DeliveryReceiptSchema }),
	obj({ state: literal("done"), receipt: DeliveryReceiptSchema }),
	obj({ state: literal("unanswered"), receipt: DeliveryReceiptSchema }),
]);
const DeliveryKey = obj({ id: str(), intentHash: str() });

export const WakePhaseSchema = union([
	obj({ kind: literal("scheduled") }),
	obj({ kind: literal("pending") }),
	obj({ kind: literal("uncertain"), policy: union([literal("retry"), literal("readback-only")]) }),
	obj({ kind: literal("admitted"), receipt: DeliveryReceiptSchema }),
	obj({
		kind: literal("settled"),
		receipt: DeliveryReceiptSchema,
		outcome: union([literal("done"), literal("unanswered")]),
	}),
	obj({ kind: literal("closed"), reason: union([literal("cancelled"), literal("blocked")]) }),
]);
export const WakeSchema = obj({ delivery: DeliverySchema, phase: WakePhaseSchema, lastError: opt(str()) });
const Register = obj({
	session: str(),
	conversation: int(),
	requestId: str(),
	at: str(),
	text: str({ minLength: 1, maxLength: 32768 }),
});

/** Host-lifetime persisted wake ownership; callers authenticate at the remote facade. */
export const WakeStore = local("p2.wake-store", {
	version: 1,
	params: {},
	members: {
		register: method(Register, WakeSchema),
		list: method(obj({ session: str() }), arr(WakeSchema)),
		cancel: method(obj({ session: str(), id: str() }), WakeSchema),
	},
});

/** The owner may inspect explicit targets; current workers can only manage their own session. */
export const Wakes = remote("p2.wakes", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			methods: {
				registerTarget: method(Register, WakeSchema),
				listTarget: method(obj({ session: str() }), arr(WakeSchema)),
				cancelTarget: method(obj({ session: str(), id: str() }), WakeSchema),
			},
		},
		worker: {
			methods: {
				register: method(
					obj({ conversation: int(), requestId: str(), at: str(), text: str({ minLength: 1, maxLength: 32768 }) }),
					WakeSchema,
				),
				list: method(obj({}), arr(WakeSchema)),
				cancel: method(obj({ id: str() }), WakeSchema),
			},
		},
	},
});

/** One local owner for both new receipts and the unchanged legacy ingress ledger. */
export const Admission = local("p2.stimulus-admission", {
	version: 1,
	params: {},
	members: {
		legacyAdmit: method(LegacyArgs, union([ReceiptSchema, Conflict])),
		legacyReceipt: method(LegacyKey, union([ReceiptSchema, nul()])),
		admit: method(DeliverySchema, DeliveryResult),
		status: method(DeliveryKey, DeliveryStatus),
	},
});

/** Only the server may deliver a saved wake or recover its native submission. */
export const StimulusWorker = remote("p2.stimulus-worker", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				admit: method(DeliverySchema, DeliveryResult),
				status: method(DeliveryKey, DeliveryStatus),
			},
		},
	},
});
