import { describe, expect, it } from "vitest";
import {
  createArrayProjection,
  createArrayStore,
  createAsync,
  createComputed,
  createEffect,
  createLayoutEffect,
  createLinkedSignal,
  createMemo,
  createMutable,
  createMutableStore,
  createProjection,
  createReactiveArray,
  createResource,
  createRoot,
  createSelector,
  createSignal,
  createStore,
  onCleanup,
  onMount,
} from "../src/index";

describe("global and root scopes", () => {
  it("supports creating primitives outside component setup by default", () => {
    const [count, setCount] = createSignal(1);
    const doubled = createMemo(() => count() * 2);
    const linked = createLinkedSignal(() => count());
    const [store, setStore] = createStore({ value: 1 });
    const mutable = createMutable({ value: 2 });
    const mutableStore = createMutableStore({ value: 3 });
    const arr = createReactiveArray([1]);
    const arrStore = createArrayStore([2]);

    const events: string[] = [];
    createLayoutEffect(() => {
      events.push("layout");
    });
    createEffect(() => {
      events.push(`effect:${count()}`);
    });
    createComputed(() => {
      events.push(`computed:${doubled()}`);
    });
    onMount(() => {
      events.push("mount");
    });
    onCleanup(() => {
      events.push("cleanup");
    });

    const [resource] = createResource(async () => 10);
    const asyncValue = createAsync(async () => 20);

    const projection = createProjection(
      () => count(),
      (value) => ({ value }),
      (target, value) => {
        target.value = value;
      },
    );
    const items = createArrayProjection(
      () => [{ id: "a", value: count() }],
      {
        key: (item) => item.id,
        map: (item) => ({ ...item }),
        update: (target, item) => {
          target.value = item.value;
        },
      },
    );

    expect(count()).toBe(1);
    expect(doubled()).toBe(2);
    expect(linked.value()).toBe(1);
    expect(store.value).toBe(1);
    expect(mutable.value).toBe(2);
    expect(mutableStore.value).toBe(3);
    expect(arr.join(",")).toBe("1");
    expect(arrStore.join(",")).toBe("2");
    expect(projection.value).toBe(1);
    expect(items[0]?.value).toBe(1);

    setCount(2);
    setStore({ value: 4 });
    mutable.value = 5;
    mutableStore.value = 6;
    arr.push(7);
    arrStore.push(8);

    expect(count()).toBe(2);
    expect(doubled()).toBe(4);
    expect(linked.value()).toBe(2);
    expect(store.value).toBe(4);
    expect(mutable.value).toBe(5);
    expect(mutableStore.value).toBe(6);
    expect(arr.join(",")).toBe("1,7");
    expect(arrStore.join(",")).toBe("2,8");
    expect(projection.value).toBe(2);
    expect(items[0]?.value).toBe(2);
    expect(events.some((entry) => entry.startsWith("effect:"))).toBe(true);
    expect(events.some((entry) => entry.startsWith("computed:"))).toBe(true);

    void resource();
    void asyncValue();
  });

  it("supports isolated disposable scopes via createRoot", () => {
    const events: string[] = [];

    const root = createRoot((dispose) => {
      const [value, setValue] = createSignal(1);

      createEffect(() => {
        events.push(`value:${value()}`);
      });

      onCleanup(() => {
        events.push("root-cleanup");
      });

      return { value, setValue, dispose };
    });

    root.setValue(2);
    expect(root.value()).toBe(2);
    expect(events).toContain("value:1");
    expect(events).toContain("value:2");

    root.dispose();
    expect(events).toContain("root-cleanup");
  });

  it("allows non-scope selectors outside components", () => {
    const selector = createSelector(() => "a");
    expect(selector("a")).toBe(true);
    expect(selector("b")).toBe(false);
  });
});
