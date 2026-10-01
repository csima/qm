import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("shared menu selection supports keyboard navigation and preserves disabled choices", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    const { menuSelect } = await vite.ssrLoadModule("/src/ui.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const selected: Array<string | null> = [];
    const props = {
      value: "private",
      ariaLabel: "Sharing",
      ariaDescription: "Choose who can access this app",
      onSelect: (value: string | null) => selected.push(value),
      options: [
        { value: "private", label: "Private" },
        { value: "team", label: "Team" },
        { value: "public", label: "Public", disabledHint: "External sharing is disabled" },
      ],
    };
    render(menuSelect(props), host);
    const trigger = host.querySelector<HTMLButtonElement>(".menu-button")!;
    const menu = host.querySelector<HTMLElement>(".menu-popover")!;
    const options = [...host.querySelectorAll<HTMLButtonElement>(".menu-option")];
    const key = (target: HTMLElement, value: string) =>
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    assert.equal(trigger.getAttribute("aria-description"), props.ariaDescription);
    key(trigger, "ArrowDown");
    assert.equal(menu.hidden, false);
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "End");
    assert.equal(document.activeElement, options[2]);
    assert.equal(options[2]!.getAttribute("aria-disabled"), "true");
    options[2]!.click();
    assert.equal(selected.length, 0);
    assert.equal(menu.hidden, false);
    key(options[2]!, "ArrowDown");
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "ArrowUp");
    assert.equal(document.activeElement, options[2]);
    key(options[2]!, "Home");
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "ArrowDown");
    options[1]!.click();
    assert.deepEqual(selected, ["team"]);
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    key(trigger, "ArrowUp");
    assert.equal(document.activeElement, options[2]);
    key(options[2]!, "Escape");
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    trigger.click();
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "Tab");
    assert.equal(menu.hidden, true);
    render(menuSelect({ ...props, disabled: true }), host);
    assert.equal(trigger.disabled, true);
    assert.ok(options.every((option) => option.disabled));
    trigger.click();
    key(trigger, "ArrowDown");
    options[1]!.click();
    assert.equal(menu.hidden, true);
    assert.deepEqual(selected, ["team"]);
  } finally {
    await close();
  }
});
