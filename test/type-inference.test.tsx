import * as React from "react";
import { describe, expectTypeOf, it } from "vitest";
import {
  Match,
  Show,
  component,
  createLinkedSignal,
  createMemo,
  createSignal,
  type Accessor,
  type Falsy,
  type Setter,
  type Truthy,
} from "../src/index";

describe("type inference and narrowing", () => {
  it("infers createSignal getter/setter types", () => {
    const App = component(() => {
      const [count, setCount] = createSignal(1);
      expectTypeOf(count).toEqualTypeOf<Accessor<number>>();
      expectTypeOf(setCount).toEqualTypeOf<Setter<number>>();

      setCount((prev) => prev + 1);
      const next = setCount(4);
      expectTypeOf(next).toEqualTypeOf<number>();

      return () => <span>{count()}</span>;
    });

    expectTypeOf(App).toEqualTypeOf<React.ComponentType<Record<string, never>>>();
  });

  it("infers createMemo and linked signal value/setter types", () => {
    component(() => {
      const [source] = createSignal({ id: "a", count: 1 as number | null });
      const id = createMemo(() => source().id);
      expectTypeOf(id).toEqualTypeOf<Accessor<string>>();

      const linked = createLinkedSignal(() => source().count ?? 0);
      expectTypeOf(linked.value).toEqualTypeOf<Accessor<number>>();
      expectTypeOf(linked.set).toEqualTypeOf<Setter<number>>();
      expectTypeOf(linked.reset).toEqualTypeOf<() => number>();
      expectTypeOf(linked.isOverridden).toEqualTypeOf<Accessor<boolean>>();

      return () => <span>{linked.value()}</span>;
    });
  });

  it("narrows Show/Match callback argument to truthy type", () => {
    type MaybeUser = { id: string } | null | "";

    const user: MaybeUser = { id: "x" };

    const show = (
      <Show when={user}>
        {(value) => {
          expectTypeOf(value).toEqualTypeOf<Truthy<{ id: string }>>();
          return <span>{value.id}</span>;
        }}
      </Show>
    );

    const match = (
      <Match when={user}>
        {(value) => {
          expectTypeOf(value).toEqualTypeOf<Truthy<{ id: string }>>();
          return <span>{value.id}</span>;
        }}
      </Match>
    );

    expectTypeOf(show).toMatchTypeOf<React.ReactNode>();
    expectTypeOf(match).toMatchTypeOf<React.ReactElement | null>();
  });

  it("exports falsy/truthy utility types", () => {
    expectTypeOf<Falsy>().toEqualTypeOf<false | 0 | 0n | "" | null | undefined>();
    expectTypeOf<Truthy<string | "" | null>>().toEqualTypeOf<string>();
  });
});
