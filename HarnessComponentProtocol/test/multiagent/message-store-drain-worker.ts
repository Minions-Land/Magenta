import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";

const [dbPath, recipient, rawLimit] = process.argv.slice(2);
if (!dbPath || !recipient || !rawLimit)
	throw new Error("message-store drain worker requires dbPath, recipient, and limit");

const store = new MessageStore(dbPath);
process.send?.({ type: "ready" });
process.once("message", (message) => {
	if (message !== "go") return;
	try {
		const drained = store.drainUnread(recipient, Number(rawLimit));
		process.send?.({
			type: "result",
			ids: drained.map((entry) => entry.id),
			contents: drained.map((entry) => entry.content),
		});
	} finally {
		store.close();
		process.disconnect?.();
	}
});
