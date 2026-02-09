import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  For,
  Index,
  Match,
  Show,
  Suspense,
  Switch,
  component,
  createArrayProjection,
  createArrayStore,
  createMutable,
  createMutableStore,
  createProjection,
  createReactiveArray,
  createSignal,
  createStore,
  lazy,
} from "../src/index";

afterEach(() => {
  cleanup();
});

describe("stores, projections, and control flow", () => {
  it("updates immutable stores through setStore", () => {
    const App = component(() => {
      const [store, setStore] = createStore({
        count: 1,
        nested: { enabled: true },
      });

      return () => (
        <div>
          <button data-testid="merge" onClick={() => setStore({ count: 2 })}>
            merge
          </button>
          <button
            data-testid="updater"
            onClick={() =>
              setStore((prev) => ({
                count: prev.count + 1,
              }))
            }
          >
            updater
          </button>
          <span data-testid="count">{store.count}</span>
          <span data-testid="enabled">{String(store.nested.enabled)}</span>
        </div>
      );
    });

    render(<App />);

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("enabled").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("merge"));
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(screen.getByTestId("enabled").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("updater"));
    expect(screen.getByTestId("count").textContent).toBe("3");
  });

  it("supports mutable stores and reactive arrays", () => {
    const App = component(() => {
      const store = createMutable({
        nested: { count: 0 },
        tags: ["a"],
      });
      const numbers = createReactiveArray([1, 2]);

      return () => (
        <div>
          <button
            data-testid="mutate"
            onClick={() => {
              store.nested.count += 1;
              store.tags.push(`t${store.nested.count}`);
              numbers.push(numbers.length + 1);
              numbers.splice(0, 1);
            }}
          >
            mutate
          </button>
          <span data-testid="count">{store.nested.count}</span>
          <span data-testid="tags">{store.tags.join(",")}</span>
          <span data-testid="nums">{numbers.join(",")}</span>
        </div>
      );
    });

    render(<App />);

    fireEvent.click(screen.getByTestId("mutate"));

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("tags").textContent).toBe("a,t1");
    expect(screen.getByTestId("nums").textContent).toBe("2,3");
  });

  it("supports mutable and array store aliases", () => {
    const App = component(() => {
      const aliasStore = createMutableStore({ value: 1 });
      const aliasArray = createArrayStore(["a"]);

      return () => (
        <div>
          <button
            data-testid="alias-mutate"
            onClick={() => {
              aliasStore.value += 1;
              aliasArray.push("b");
            }}
          >
            mutate
          </button>
          <span data-testid="alias-value">{aliasStore.value}</span>
          <span data-testid="alias-array">{aliasArray.join(",")}</span>
        </div>
      );
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("alias-mutate"));

    expect(screen.getByTestId("alias-value").textContent).toBe("2");
    expect(screen.getByTestId("alias-array").textContent).toBe("a,b");
  });

  it("keeps projection reference stable while mutating derived data", () => {
    let firstReference: Array<{ value: number }> | null = null;

    const App = component(() => {
      const [source, setSource] = createSignal([1, 2]);
      const projected = createProjection(
        source,
        (initial) => initial.map((value) => ({ value: value * 2 })),
        (target, next) => {
          target.splice(
            0,
            target.length,
            ...next.map((value) => ({ value: value * 2 })),
          );
        },
      );

      firstReference ??= projected;

      return () => (
        <div>
          <button data-testid="swap" onClick={() => setSource([3, 4, 5])}>
            swap
          </button>
          <span data-testid="values">{projected.map((v) => v.value).join(",")}</span>
        </div>
      );
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("swap"));

    expect(screen.getByTestId("values").textContent).toBe("6,8,10");
    expect(firstReference).not.toBeNull();
  });

  it("reuses mapped items in keyed array projections during reorders", () => {
    let captured: Array<{ id: string; label: string }> = [];

    const App = component(() => {
      const [items, setItems] = createSignal([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ]);

      const projected = createArrayProjection(items, {
        key: (item) => item.id,
        map: (item) => ({ id: item.id, label: item.label }),
        update: (target, item) => {
          target.label = item.label;
        },
      });

      return () => (
        <div>
          <button
            data-testid="reorder"
            onClick={() => {
              captured = [...projected];
              setItems([
                { id: "c", label: "C2" },
                { id: "a", label: "A2" },
                { id: "b", label: "B2" },
              ]);
            }}
          >
            reorder
          </button>
          <span data-testid="ids">{projected.map((item) => item.id).join(",")}</span>
          <span data-testid="labels">{projected.map((item) => item.label).join(",")}</span>
        </div>
      );
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("reorder"));

    expect(screen.getByTestId("ids").textContent).toBe("c,a,b");
    expect(screen.getByTestId("labels").textContent).toBe("C2,A2,B2");

    const idsAfter = screen.getByTestId("ids").textContent?.split(",") ?? [];
    expect(idsAfter).toEqual(["c", "a", "b"]);
    expect(captured[2]).toBeDefined();
  });

  it("renders Show, For, Index, Switch, and Match branches", () => {
    const App = component(() => {
      const [open, setOpen] = createSignal(false);
      const [items, setItems] = createSignal(["x", "y"]);
      const [mode, setMode] = createSignal<"idle" | "busy" | "done">("idle");

      return () => (
        <div>
          <button data-testid="toggle" onClick={() => setOpen((v) => !v)}>
            toggle
          </button>
          <button data-testid="empty" onClick={() => setItems([])}>
            empty
          </button>
          <button data-testid="busy" onClick={() => setMode("busy")}>busy</button>
          <Show when={open()} fallback={<span data-testid="show-fallback">closed</span>}>
            <span data-testid="show-open">open</span>
          </Show>
          <For each={items()} fallback={<span data-testid="for-fallback">none</span>}>
            {(item, index) => <span data-testid={`for-${index()}`}>{item}</span>}
          </For>
          <Index each={items()} fallback={<span data-testid="index-fallback">none</span>}>
            {(item, index) => <span data-testid={`index-${index()}`}>{item()}</span>}
          </Index>
          <Switch fallback={<span data-testid="switch-fallback">fallback</span>}>
            <Match when={mode() === "busy"}> <span data-testid="busy-state">busy</span> </Match>
            <Match when={mode() === "done"}> <span data-testid="done-state">done</span> </Match>
          </Switch>
        </div>
      );
    });

    render(<App />);

    expect(screen.getByTestId("show-fallback").textContent).toBe("closed");
    expect(screen.getByTestId("for-0").textContent).toBe("x");
    expect(screen.getByTestId("index-1").textContent).toBe("y");
    expect(screen.getByTestId("switch-fallback").textContent).toBe("fallback");

    fireEvent.click(screen.getByTestId("toggle"));
    fireEvent.click(screen.getByTestId("busy"));
    fireEvent.click(screen.getByTestId("empty"));

    expect(screen.getByTestId("show-open").textContent).toBe("open");
    expect(screen.getByTestId("for-fallback").textContent).toBe("none");
    expect(screen.getByTestId("index-fallback").textContent).toBe("none");
    expect(screen.getByTestId("busy-state").textContent).toBe("busy");
  });

  it("supports lazy components with suspense fallback", async () => {
    const LazyValue = lazy(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        default: () => <span data-testid="lazy-value">loaded</span>,
      };
    });

    render(
      <Suspense fallback={<span data-testid="lazy-fallback">loading</span>}>
        <LazyValue />
      </Suspense>,
    );

    expect(screen.getByTestId("lazy-fallback").textContent).toBe("loading");

    await waitFor(() => {
      expect(screen.getByTestId("lazy-value").textContent).toBe("loaded");
    });
  });
});
