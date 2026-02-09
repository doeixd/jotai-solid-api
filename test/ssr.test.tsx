/** @vitest-environment node */
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { component, createMemo, createRoot, createSignal } from "../src/index";

describe("ssr behavior", () => {
  it("renders wrapped components with react-dom/server", () => {
    const Counter = component<{ initial: number }>((props) => {
      const [count] = createSignal(props().initial);
      const doubled = createMemo(() => count() * 2);
      return () => <span>{doubled()}</span>;
    });

    const html = renderToString(<Counter initial={2} />);
    expect(html).toContain("4");
  });

  it("requires createRoot for primitives outside components in SSR", () => {
    expect(() => createSignal(1)).toThrow(
      "No active reactive scope in SSR context",
    );
  });

  it("supports isolated request-style scopes via createRoot", () => {
    const requestA = createRoot((dispose) => {
      const [value, setValue] = createSignal(1);
      setValue((n) => n + 1);
      const snapshot = value();
      dispose();
      return snapshot;
    });

    const requestB = createRoot((dispose) => {
      const [value] = createSignal(10);
      const snapshot = value();
      dispose();
      return snapshot;
    });

    expect(requestA).toBe(2);
    expect(requestB).toBe(10);
  });
});
