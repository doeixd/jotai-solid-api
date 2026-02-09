import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  children,
  component,
  createDeferred,
  createRoot,
  createSignal,
  createStore,
  createUniqueId,
  mergeProps,
  produce,
  reconcile,
  splitProps,
} from "../src/index";

afterEach(() => {
  cleanup();
});

describe("additional primitives", () => {
  it("supports createDeferred updates", async () => {
    const App = component(() => {
      const [value, setValue] = createSignal("a");
      const deferred = createDeferred(value, { timeoutMs: 5 });

      return () => (
        <div>
          <button data-testid="set" onClick={() => setValue("b")}>set</button>
          <span data-testid="value">{value()}</span>
          <span data-testid="deferred">{deferred()}</span>
        </div>
      );
    });

    render(<App />);
    expect(screen.getByTestId("deferred").textContent).toBe("a");

    fireEvent.click(screen.getByTestId("set"));
    expect(screen.getByTestId("value").textContent).toBe("b");

    await waitFor(() => {
      expect(screen.getByTestId("deferred").textContent).toBe("b");
    });
  });

  it("supports mergeProps and splitProps", () => {
    const merged = mergeProps({ a: 1, b: 1 }, { b: 2, c: 3 }, { c: 4 });
    expect(merged.a).toBe(1);
    expect(merged.b).toBe(2);
    expect(merged.c).toBe(4);

    const props = { id: "x", name: "n", value: 1, extra: true };
    const [picked, rest] = splitProps(props, ["id", "name"]);
    expect(picked.id).toBe("x");
    expect(picked.name).toBe("n");
    expect((rest as { value: number }).value).toBe(1);
    expect((rest as { extra: boolean }).extra).toBe(true);
  });

  it("supports children helper resolution", () => {
    const App = component(() => {
      const resolved = children(() => [<span key="a">a</span>, <span key="b">b</span>]);

      return () => <div data-testid="len">{String(resolved.toArray().length)}</div>;
    });

    render(<App />);
    expect(screen.getByTestId("len").textContent).toBe("2");
  });

  it("supports createUniqueId across scoped roots", () => {
    const first = createRoot(() => createUniqueId("t-"));
    const second = createRoot(() => createUniqueId("t-"));

    expect(first).toBe("t-1");
    expect(second).toBe("t-1");
  });

  it("supports produce and reconcile helpers with stores", () => {
    const App = component(() => {
      const [state, setState] = createStore({
        user: { id: "1", name: "A" },
        items: [{ id: "1", value: 1 }, { id: "2", value: 2 }],
      });

      return () => (
        <div>
          <button
            data-testid="produce"
            onClick={() => {
              setState(produce((draft) => {
                draft.user.name = "B";
              }));
            }}
          >
            produce
          </button>
          <button
            data-testid="reconcile"
            onClick={() => {
              setState(reconcile({
                user: { id: "1", name: "C" },
                items: [{ id: "2", value: 20 }, { id: "1", value: 10 }],
              }, { key: "id", merge: true }));
            }}
          >
            reconcile
          </button>
          <span data-testid="name">{state.user.name}</span>
          <span data-testid="items">{state.items.map((item) => `${item.id}:${item.value}`).join(",")}</span>
        </div>
      );
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("produce"));
    expect(screen.getByTestId("name").textContent).toBe("B");

    fireEvent.click(screen.getByTestId("reconcile"));
    expect(screen.getByTestId("name").textContent).toBe("C");
    expect(screen.getByTestId("items").textContent).toBe("2:20,1:10");
  });
});
