import { performance } from "node:perf_hooks";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal.ts";
import { Container, StaticPrefixContainer, TUI } from "../src/tui.ts";

class NullTerminal implements Terminal {
	columns = 120;
	rows = 50;
	kittyProtocolActive = false;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

type RenderableTUI = TUI & { doRender(): void };

function percentile(samples: number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
	return sorted[index] ?? 0;
}

function benchmark(mode: "plain" | "static", historySize: number, frames: number, rounds: number) {
	const tui = new TUI(new NullTerminal()) as RenderableTUI;
	const chat = mode === "static" ? new StaticPrefixContainer() : new Container();
	for (let index = 0; index < historySize; index++) {
		chat.addChild(new Text(`history ${index}: ${"x".repeat(70)}`, 0, 0));
	}
	const live = new Text("live 0", 0, 0);
	if (chat instanceof StaticPrefixContainer) chat.beginMutableTail();
	chat.addChild(live);
	tui.addChild(chat);
	tui.doRender();

	for (let frame = 0; frame < Math.min(50, frames); frame++) {
		live.setText(`warmup ${frame}`);
		tui.doRender();
	}

	const samples: number[] = [];
	let sequence = 0;
	for (let round = 0; round < rounds; round++) {
		const started = performance.now();
		for (let frame = 0; frame < frames; frame++) {
			live.setText(`live ${sequence++}`);
			tui.doRender();
		}
		samples.push((performance.now() - started) / frames);
	}

	return {
		mode,
		historySize,
		frames,
		rounds,
		medianMsPerFrame: percentile(samples, 0.5),
		p95MsPerFrame: percentile(samples, 0.95),
	};
}

const historySizes = (process.env.TUI_BENCH_SIZES ?? "1000,5000,20000")
	.split(",")
	.map((value) => Number(value.trim()))
	.filter((value) => Number.isFinite(value) && value > 0);
const frames = Number(process.env.TUI_BENCH_FRAMES ?? 200);
const rounds = Number(process.env.TUI_BENCH_ROUNDS ?? 5);

for (const historySize of historySizes) {
	for (const mode of ["plain", "static"] as const) {
		console.log(JSON.stringify(benchmark(mode, historySize, frames, rounds)));
	}
}
