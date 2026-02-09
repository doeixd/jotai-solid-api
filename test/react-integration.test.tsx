import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Suspense,
  component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  use,
} from "../src/index";

afterEach(() => {
  cleanup();
});

class TestBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): { hasError: boolean; message: string } {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? <span data-testid="boundary">{this.state.message}</span>;
    }
    return this.props.children;
  }
}

describe("react integration", () => {
  it("works correctly under React.StrictMode lifecycle behavior", async () => {
    const events: string[] = [];

    const App = component(() => {
      const [count, setCount] = createSignal(0);

      onMount(() => {
        events.push("mount");
        return () => {
          events.push("unmount");
        };
      });

      createEffect(() => {
        events.push(`effect:${count()}`);
        onCleanup(() => {
          events.push(`effect-cleanup:${count()}`);
        });
      });

      return () => (
        <button data-testid="strict-inc" onClick={() => setCount((n) => n + 1)}>
          {count()}
        </button>
      );
    });

    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByTestId("strict-inc"));
    expect(screen.getByTestId("strict-inc").textContent).toBe("0");

    unmount();

    expect(events.some((entry) => entry === "mount")).toBe(true);
    expect(events.some((entry) => entry === "unmount")).toBe(true);
    expect(events.some((entry) => entry === "effect:0")).toBe(true);
  });

  it("handles startTransition updates and memo recalculation", async () => {
    const App = component(() => {
      const [value, setValue] = createSignal(1);
      const doubled = createMemo(() => value() * 2);

      return () => (
        <button
          data-testid="transition-btn"
          onClick={() => {
            React.startTransition(() => {
              setValue(5);
            });
          }}
        >
          {doubled()}
        </button>
      );
    });

    render(<App />);
    expect(screen.getByTestId("transition-btn").textContent).toBe("2");

    fireEvent.click(screen.getByTestId("transition-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("transition-btn").textContent).toBe("10");
    });
  });

  it("works with React error boundaries for render-time failures", async () => {
    const Crashy = component(() => {
      const [shouldCrash, setShouldCrash] = createSignal(false);

      return () => {
        if (shouldCrash()) {
          throw new Error("boom");
        }

        return (
          <button data-testid="crash" onClick={() => setShouldCrash(true)}>
            safe
          </button>
        );
      };
    });

    render(
      <TestBoundary fallback={<span data-testid="boundary-fallback">error</span>}>
        <Crashy />
      </TestBoundary>,
    );

    fireEvent.click(screen.getByTestId("crash"));

    await waitFor(() => {
      expect(screen.getByTestId("boundary-fallback").textContent).toBe("error");
    });
  });

  it("supports suspense with promise transitions and use()", async () => {
    const valueSource: { current: Promise<string> } = {
      current: new Promise((resolve) => setTimeout(() => resolve("one"), 20)),
    };

    const Reader = (): React.ReactNode => {
      return <span data-testid="value">{use(valueSource.current)}</span>;
    };

    const App = (): React.ReactNode => {
      const [, setVersion] = React.useState(0);

      return (
        <div>
          <button
            data-testid="swap-promise"
            onClick={() => {
              valueSource.current = new Promise((resolve) => setTimeout(() => resolve("two"), 10));
              React.startTransition(() => {
                setVersion((n) => n + 1);
              });
            }}
          >
            swap
          </button>
          <Reader />
        </div>
      );
    };

    render(
      <Suspense fallback={<span data-testid="suspense-fallback">loading</span>}>
        <App />
      </Suspense>,
    );

    expect(screen.getByTestId("suspense-fallback").textContent).toBe("loading");

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("one");
    });

    fireEvent.click(screen.getByTestId("swap-promise"));

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("two");
    });
  });

  it("keeps component scopes isolated across multiple instances", () => {
    const Counter = component<{ label: string }>((props) => {
      const [count, setCount] = createSignal(0);
      return () => (
        <button data-testid={`counter-${props().label}`} onClick={() => setCount((n) => n + 1)}>
          {props().label}:{count()}
        </button>
      );
    });

    render(
      <div>
        <Counter label="a" />
        <Counter label="b" />
      </div>,
    );

    fireEvent.click(screen.getByTestId("counter-a"));

    expect(screen.getByTestId("counter-a").textContent).toBe("a:1");
    expect(screen.getByTestId("counter-b").textContent).toBe("b:0");
  });
});
