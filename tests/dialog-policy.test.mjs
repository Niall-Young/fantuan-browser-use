import test from "node:test";
import assert from "node:assert/strict";
import { resolveJavaScriptDialogAction } from "../extension/dialog-policy.js";

test("resolveJavaScriptDialogAction auto-accepts alert dialogs", () => {
  const result = resolveJavaScriptDialogAction({
    type: "alert",
    message: "Saved successfully",
    url: "https://example.com/editor",
  });

  assert.deepEqual(result, {
    type: "alert",
    accept: true,
    handled: "accept",
    message: "Saved successfully",
    url: "https://example.com/editor",
  });
});

test("resolveJavaScriptDialogAction dismisses confirm, prompt, and beforeunload dialogs by default", () => {
  for (const type of ["confirm", "prompt", "beforeunload"]) {
    const result = resolveJavaScriptDialogAction({
      type,
      message: "Are you sure?",
      url: "https://example.com/item",
    });

    assert.equal(result.type, type);
    assert.equal(result.accept, false);
    assert.equal(result.handled, "dismiss");
    assert.equal(result.message, "Are you sure?");
    assert.equal(result.url, "https://example.com/item");
  }
});

test("resolveJavaScriptDialogAction defaults missing type to alert and truncates long messages", () => {
  const longMessage = "x".repeat(600);
  const result = resolveJavaScriptDialogAction({ message: longMessage });

  assert.equal(result.type, "alert");
  assert.equal(result.accept, true);
  assert.equal(result.handled, "accept");
  assert.equal(result.message.length, 500);
  assert.equal(result.url, "");
});

test("resolveJavaScriptDialogAction dismisses unknown dialog types safely", () => {
  const result = resolveJavaScriptDialogAction({
    type: "custom",
    message: "Proceed?",
  });

  assert.equal(result.accept, false);
  assert.equal(result.handled, "dismiss");
});
