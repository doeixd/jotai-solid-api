import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Suspense,
  batch,
  cleanup as onCleanupAlias,
  computed,
  component,
  createComputed,
  createAsync,
  createEffect,
  createLayoutEffect,
  createLinkedSignal,
  createMemo,
  createResource,
  createSignal,
  effect,
  fromSignal,
  fromSolidSignal,
  linkedSignal,
  memo,
  mount,
  onMount,
  onCleanup,
  signal,
  toSignal,
  toSolidSignal,
  untrack,
  use,
} from "../src/index";

afterEach(() => {
  cleanup();
});

describe("reactive primitives", () => {
  it("tracks signal and memo updates across renders", async () => {
    const runs: string[] = [];

    const Counter = component(() => {
      const [count, setCount] = createSignal(1);
      const doubled = createMemo(() => count() * 2);

      createEffect(() => {
        runs.push(`${count()}-${doubled()}`);
      });

      return () => (
        <button data-testid="inc" onClick={() => setCount((n) => n + 1)}>
          {doubled()}
        </button>
      );
    });

    render(<Counter />);

    expect(screen.getByTestId("inc").textContent).toBe("2");

    await waitFor(() => {
      expect(runs).toContain("1-2");
    });

    fireEvent.click(screen.getByTestId("inc"));
    expect(screen.getByTestId("inc").textContent).toBe("4");

    await waitFor(() => {
      expect(runs).toContain("2-4");
    });
  });

  it("runs layout effects before normal effects", async () => {
    const order: string[] = [];

    const App = component(() => {
      createLayoutEffect(() => {
        order.push("layout");
      });

      createEffect(() => {
        order.push("effect");
      });

      return () => <div>ok</div>;
    });

    render(<App />);

    await waitFor(() => {
      expect(order).toContain("effect");
    });

    expect(order[0]).toBe("layout");
    expect(order[1]).toBe("effect");
  });

  it("supports effect cleanup and setup-scope cleanup", async () => {
    const events: string[] = [];

    const App = component(() => {
      const [flag, setFlag] = createSignal(false);

      onCleanup(() => {
        events.push("scope-cleanup");
      });
      onCleanupAlias(() => {
        events.push("scope-cleanup-alias");
      });

      createEffect(() => {
        events.push(flag() ? "effect-on" : "effect-off");
        onCleanup(() => {
          events.push("effect-cleanup");
        });
      });

      return () => (
        <button data-testid="toggle" onClick={() => setFlag((v) => !v)}>
          {String(flag())}
        </button>
      );
    });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(events).toContain("effect-off");
    });

    fireEvent.click(screen.getByTestId("toggle"));

    await waitFor(() => {
      expect(events).toContain("effect-on");
    });

    expect(events).toContain("effect-cleanup");

    unmount();
    expect(events).toContain("scope-cleanup");
    expect(events).toContain("scope-cleanup-alias");
  });

  it("supports untrack to prevent dependency subscriptions", async () => {
    const memoValues: number[] = [];

    const App = component(() => {
      const [tracked, setTracked] = createSignal(1);
      const [untracked, setUntracked] = createSignal(10);

      const value = createMemo(() => tracked() + untrack(() => untracked()));

      createEffect(() => {
        memoValues.push(value());
      });

      return () => (
        <div>
          <button data-testid="tracked" onClick={() => setTracked((v) => v + 1)}>
            t
          </button>
          <button data-testid="untracked" onClick={() => setUntracked((v) => v + 5)}>
            u
          </button>
          <span data-testid="value">{value()}</span>
        </div>
      );
    });

    render(<App />);

    await waitFor(() => {
      expect(memoValues).toContain(11);
    });

    fireEvent.click(screen.getByTestId("untracked"));
    expect(screen.getByTestId("value").textContent).toBe("11");

    fireEvent.click(screen.getByTestId("tracked"));
    expect(screen.getByTestId("value").textContent).toBe("17");
  });

  it("supports component memo option while preserving internal reactivity", async () => {
    let renderCount = 0;

    const App = component<{ value: number }>(
      (props) => {
        const [count, setCount] = createSignal(0);

        return () => {
          renderCount += 1;
          return (
            <button data-testid="btn" onClick={() => setCount((v) => v + 1)}>
              {props().value}:{count()}
            </button>
          );
        };
      },
      { memo: true },
    );

    const { rerender } = render(<App value={1} />);
    rerender(<App value={1} />);

    expect(renderCount).toBe(1);

    fireEvent.click(screen.getByTestId("btn"));
    await waitFor(() => {
      expect(renderCount).toBe(2);
    });
  });

  it("handles createResource fetch lifecycle and refetch", async () => {
    let calls = 0;

    const App = component(() => {
      const [resource, controls] = createResource(async () => {
        calls += 1;
        await Promise.resolve();
        return calls;
      });

      return () => (
        <div>
          <button data-testid="refetch" onClick={() => controls.refetch()}>
            refetch
          </button>
          <span data-testid="state">{resource.state()}</span>
          <span data-testid="value">{String(resource() ?? "")}</span>
        </div>
      );
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("ready");
      expect(screen.getByTestId("value").textContent).toBe("1");
    });

    fireEvent.click(screen.getByTestId("refetch"));

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("2");
    });
  });

  it("ignores stale createResource responses in source mode", async () => {
    const App = component(() => {
      const [id, setId] = createSignal(1);
      const [resource] = createResource(id, async (value) => {
        if (value === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return value * 10;
      });

      return () => (
        <div>
          <button data-testid="set-2" onClick={() => setId(2)}>
            set
          </button>
          <span data-testid="value">{String(resource() ?? "")}</span>
        </div>
      );
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("set-2"));

    await waitFor(
      () => {
        expect(screen.getByTestId("value").textContent).toBe("20");
      },
      { timeout: 200 },
    );
  });

  it("provides createAsync and use helpers", async () => {
    const AsyncValue = component(() => {
      const resource = createAsync(async () => {
        await Promise.resolve();
        return 42;
      });

      return () => <span data-testid="async">{String(resource() ?? "")}</span>;
    });

    render(<AsyncValue />);

    await waitFor(() => {
      expect(screen.getByTestId("async").textContent).toBe("42");
    });

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done"), 5);
    });

    const PromiseReader = () => <span data-testid="promise">{use(promise)}</span>;
    const AccessorReader = () => <span data-testid="accessor">{use(() => "ok")}</span>;

    render(
      <Suspense fallback={<span data-testid="fallback">loading</span>}>
        <PromiseReader />
      </Suspense>,
    );

    expect(screen.getByTestId("fallback").textContent).toBe("loading");

    await waitFor(() => {
      expect(screen.getByTestId("promise").textContent).toBe("done");
    });

    render(<AccessorReader />);
    expect(screen.getByTestId("accessor").textContent).toBe("ok");
  });

  it("supports linked signals with override and automatic reset", async () => {
    const App = component(() => {
      const [items, setItems] = createSignal(["a", "b"]);
      const linked = createLinkedSignal(() => items()[0] ?? "none");

      return () => (
        <div>
          <button data-testid="override" onClick={() => linked.set("b")}>override</button>
          <button data-testid="replace" onClick={() => setItems(["c", "d"])}>replace</button>
          <button data-testid="reset" onClick={() => linked.reset()}>reset</button>
          <span data-testid="value">{linked.value()}</span>
          <span data-testid="manual">{String(linked.isOverridden())}</span>
        </div>
      );
    });

    render(<App />);

    expect(screen.getByTestId("value").textContent).toBe("a");
    expect(screen.getByTestId("manual").textContent).toBe("false");

    fireEvent.click(screen.getByTestId("override"));
    expect(screen.getByTestId("value").textContent).toBe("b");
    expect(screen.getByTestId("manual").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("replace"));

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("c");
      expect(screen.getByTestId("manual").textContent).toBe("false");
    });

    fireEvent.click(screen.getByTestId("override"));
    fireEvent.click(screen.getByTestId("reset"));
    expect(screen.getByTestId("value").textContent).toBe("c");
    expect(screen.getByTestId("manual").textContent).toBe("false");
  });

  it("batches multiple writes into a single effect pass", async () => {
    const runs: number[] = [];

    const App = component(() => {
      const [a, setA] = createSignal(1);
      const [b, setB] = createSignal(2);

      createEffect(() => {
        runs.push(a() + b());
      });

      return () => (
        <button
          data-testid="batch"
          onClick={() => {
            batch(() => {
              setA(3);
              setB(4);
            });
          }}
        >
          go
        </button>
      );
    });

    render(<App />);

    await waitFor(() => {
      expect(runs).toEqual([3]);
    });

    fireEvent.click(screen.getByTestId("batch"));

    await waitFor(() => {
      expect(runs).toEqual([3, 7]);
    });
  });

  it("supports createComputed and onMount helpers", async () => {
    const events: string[] = [];

    const App = component(() => {
      const [count, setCount] = createSignal(0);

      createComputed(() => {
        events.push(`computed:${count()}`);
      });

      onMount(() => {
        events.push("mounted");
        return () => {
          events.push("unmounted");
        };
      });

      return () => (
        <button data-testid="inc" onClick={() => setCount((n) => n + 1)}>
          {count()}
        </button>
      );
    });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(events).toContain("mounted");
      expect(events).toContain("computed:0");
    });

    fireEvent.click(screen.getByTestId("inc"));

    await waitFor(() => {
      expect(events).toContain("computed:1");
    });

    unmount();
    expect(events).toContain("unmounted");
  });

  it("exposes linkedSignal alias", () => {
    const App = component(() => {
      const [source] = createSignal("a");
      const linked = linkedSignal(() => source());
      return () => <span data-testid="linked-alias">{linked.value()}</span>;
    });

    render(<App />);
    expect(screen.getByTestId("linked-alias").textContent).toBe("a");
  });

  it("supports short aliases for core reactive primitives", async () => {
    const events: string[] = [];

    const App = component(() => {
      const [value, setValue] = signal(1);
      const doubled = memo(() => value() * 2);

      effect(() => {
        events.push(`e:${doubled()}`);
      });

      computed(() => {
        events.push(`c:${value()}`);
      });

      mount(() => {
        events.push("m");
      });

      return () => (
        <button data-testid="alias-inc" onClick={() => setValue((n) => n + 1)}>
          {doubled()}
        </button>
      );
    });

    render(<App />);

    await waitFor(() => {
      expect(events).toContain("m");
      expect(events).toContain("e:2");
      expect(events).toContain("c:1");
    });

    fireEvent.click(screen.getByTestId("alias-inc"));

    await waitFor(() => {
      expect(events).toContain("e:4");
      expect(events).toContain("c:2");
    });
  });

  it("adapts Solid-compatible signal tuples", () => {
    let value = 1;
    const solidLike = [
      () => value,
      (next: number | ((prev: number) => number)) => {
        value = typeof next === "function" ? (next as (prev: number) => number)(value) : next;
      },
    ] as const;

    const [get, set] = fromSolidSignal(solidLike);
    expect(get()).toBe(1);
    expect(set((n) => n + 2)).toBe(3);
    expect(get()).toBe(3);

    const [get2, set2] = fromSignal(solidLike);
    set2(5);
    expect(get2()).toBe(5);
  });

  it("adapts library signals to Solid-compatible tuples", () => {
    const App = component(() => {
      const pair = createSignal(2);
      const [get, set] = toSolidSignal(pair);
      const [getAlias, setAlias] = toSignal(pair);

      return () => (
        <div>
          <button data-testid="solid-set" onClick={() => set((n) => n + 1)}>
            set
          </button>
          <button data-testid="solid-set-alias" onClick={() => setAlias((n) => n + 2)}>
            set2
          </button>
          <span data-testid="solid-value">{get()}</span>
          <span data-testid="solid-value-alias">{getAlias()}</span>
        </div>
      );
    });

    render(<App />);
    expect(screen.getByTestId("solid-value").textContent).toBe("2");

    fireEvent.click(screen.getByTestId("solid-set"));
    expect(screen.getByTestId("solid-value").textContent).toBe("3");

    fireEvent.click(screen.getByTestId("solid-set-alias"));
    expect(screen.getByTestId("solid-value-alias").textContent).toBe("5");
  });

  it("throws when reactive primitives are called outside component scope", () => {
    expect(() => createSignal(1)).toThrow("No active reactive scope");
    expect(() => createMemo(() => 1)).toThrow("No active reactive scope");
    expect(() => createEffect(() => {})).toThrow("No active reactive scope");
  });
});
