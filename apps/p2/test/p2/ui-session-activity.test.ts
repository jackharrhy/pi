// Browser disclosure for stable names: no secondary line, keyboard/hover/tap activity and explicit navigation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { SessionActivity } from "../../plugins/sessions/activity-contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

test(
	"session activity discloses on the name without renaming or replacing row navigation",
	{ skip: !browserTests, timeout: 120_000 },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Stable name" }, BACKGROUND_CONTEXT);
		const other = await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const activity = await holdIn(owner, SessionActivity, {}, "owner");
		await chat.send({ text: "set-activity Reviewing activity", requestId: "activity" }, BACKGROUND_CONTEXT);
		await until(activity.activities, (all) => all?.[session.id] === "Reviewing activity");
		const browser = await Browser.start();
		t.after(() => browser.close());
		await browser.signIn(fixture.owner);
		await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${other.id}`);
		const row = `.sidebar-section[data-key=recent] [data-session="${session.id}"]`;
		const name = `${row} .session-title`;
		const link = `${row} .session-main`;
		await browser.wait(`document.querySelector(${JSON.stringify(name)})?.textContent === 'Stable name'`);
		assert.equal(
			await browser.evaluate(`document.querySelector('.session-activity-popover:popover-open') !== null`),
			false,
		);
		await browser.wait(`document.querySelector(${JSON.stringify(link)})?.getAttribute('aria-haspopup') === 'dialog'`);
		await browser.evaluate(`document.querySelector(${JSON.stringify(link)}).focus()`);
		await browser.wait(
			`document.querySelector('.session-activity-popover:popover-open')?.textContent.includes('Reviewing activity')`,
		);
		assert.equal(await browser.evaluate("location.pathname"), `/s/${other.id}`);
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
		await browser.wait(`!document.querySelector('.session-activity-popover:popover-open')`);
		await browser.evaluate(
			`document.querySelector(${JSON.stringify(link)}).dispatchEvent(new MouseEvent('mouseover', { bubbles:true }))`,
		);
		await browser.wait(`document.querySelector('.session-activity-popover:popover-open')`);
		await browser.click(".session-activity-popover:popover-open button");
		await browser.click(name);
		await browser.wait(`document.querySelector('.session-activity-popover:popover-open')`);
		assert.equal(await browser.evaluate("location.pathname"), `/s/${other.id}`);
		await browser.click(".session-activity-popover:popover-open a");
		await browser.wait(`location.pathname === '/s/${session.id}'`);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${other.id}`);
		await browser.click(".sidebar-open");
		await browser.click(name);
		await browser.wait(`document.querySelector('.session-activity-popover:popover-open')`);
		assert.equal(await browser.evaluate("location.pathname"), `/s/${other.id}`);
		await browser.click(".session-activity-popover:popover-open a");
		await browser.wait(`location.pathname === '/s/${session.id}'`);
	},
);
