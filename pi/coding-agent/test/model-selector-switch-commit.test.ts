import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";

describe("ModelSelectorComponent model switch commit", () => {
	it("delegates selection without persisting the model before the async switch succeeds", () => {
		const model = { provider: "faux", id: "faux-2" } as Model<any>;
		const persistDefault = vi.fn();
		const onSelectCallback = vi.fn();
		const handleSelect = Reflect.get(ModelSelectorComponent.prototype, "handleSelect") as (
			this: {
				settingsManager: { setDefaultModelAndProvider: typeof persistDefault };
				onSelectCallback: typeof onSelectCallback;
			},
			selectedModel: Model<any>,
		) => void;

		handleSelect.call({ settingsManager: { setDefaultModelAndProvider: persistDefault }, onSelectCallback }, model);

		expect(onSelectCallback).toHaveBeenCalledWith(model);
		expect(persistDefault).not.toHaveBeenCalled();
	});
});
