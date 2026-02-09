[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/doeixd/jotai-solid-api)

# jotai-solid-api

Solid-style reactive primitives on top of `jotai/vanilla`, plus a React component wrapper so app code can stay hook-free.

## Install

```bash
npm install jotai-solid-api jotai react
```

## API

- `component(setup, { memo?, displayName? })`
- `createSignal(initial)`
- `fromSolidSignal(signal)` / `toSolidSignal(signal)`
- `fromSignal(signal)` / `toSignal(signal)`
- `createMemo(compute)`
- `createEffect(effect)`
- `createLayoutEffect(effect)`
- `createComputed(compute)`
- `onMount(callback)`
- `onCleanup(cleanup)` / `cleanup(cleanup)`
- `createRoot(init)`
- `batch(fn)`
- `createSelector(source, equals?)`
- `resolveMaybeAccessor(value)` / `toValue(value)`
- `isAccessor(value)`
- `createResource(fetcher)`
- `createResource(source, fetcher)`
- `createAsync(compute)`
- `use(accessorOrPromise)`
- `createStore(initial)` / `setStore(next)`
- `createMutable(initial)` / `createMutableStore(initial)`
- `createReactiveArray(initial)` / `createArrayStore(initial)`
- `createProjection(source, initialize, mutate)`
- `createArrayProjection(source, { key, map, update })`
- `createLinkedSignal(derive)` / `linkedSignal(derive)`
- `lazy(loader)` / `Suspense`
- `untrack(fn)`
- control flow: `Show`, `For`, `Index`, `Switch`, `Match`

### Aliases

- Primitives: `signal`, `memo`, `effect`, `layoutEffect`, `computed`, `mount`
- Async: `resource`, `asyncSignal`
- Stores/projections: `store`, `sotre`, `mutable`, `projection`, `arrayProjection`
- Components: `defineComponent`

## Example

```tsx
import {
  component,
  createEffect,
  createLayoutEffect,
  createMemo,
  createMutable,
  createLinkedSignal,
  createArrayProjection,
  createProjection,
  createReactiveArray,
  createResource,
  createSignal,
  createStore,
  For,
  Match,
  Suspense,
  lazy,
  Show,
  Switch,
} from "jotai-solid-api";

type CounterProps = { step?: number };

export const Counter = component<CounterProps>((props) => {
  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  const [store, setStore] = createStore({ filter: "all" as "all" | "active" });
  const mutable = createMutable({ clicks: 0, nested: { enabled: true } });
  const items = createReactiveArray<string>(["a", "b"]);
  const projectedUsers = createArrayProjection(users.latest, {
    key: (user) => user.id,
    map: (user) => ({ ...user, selected: false }),
    update: (target, user) => {
      target.name = user.name;
    },
  });
  const selected = createLinkedSignal(() => projectedUsers[0]?.id ?? null);
  const [users] = createResource(async () => {
    const response = await fetch("/api/users");
    return (await response.json()) as Array<{ id: string; name: string }>;
  });

  createLayoutEffect(() => {
    console.log("layout count", count());
  });

  createEffect(() => {
    console.log("count", count(), "step", props().step ?? 1);
  });

  return () => (
    <div>
      <button onClick={() => setCount((n) => n + (props().step ?? 1))}>
        {count()} / {doubled()}
      </button>
      <button onClick={() => setStore({ filter: store.filter === "all" ? "active" : "all" })}>
        filter: {store.filter}
      </button>
      <button onClick={() => { mutable.clicks += 1; items.push(String(mutable.clicks)); }}>
        mutable clicks: {mutable.clicks}
      </button>

      <Show when={users.loading()} fallback={<p>Loading users...</p>}>
        <For each={projectedUsers} fallback={<p>No users</p>}>
          {(user) => (
            <p onClick={() => selected.set(user.id)}>
              {user.name} {selected.value() === user.id ? "(selected)" : ""}
            </p>
          )}
        </For>
      </Show>

      <Switch fallback={<p>Ready</p>}>
        <Match when={users.error()}>{(err) => <p>Failed: {String(err)}</p>}</Match>
        <Match when={users.loading()}>
          <p>Fetching...</p>
        </Match>
      </Switch>
    </div>
  );
}, { memo: true });

const LazyPanel = lazy(async () => import("./Panel"));

export const App = component(() => {
  return () => (
    <Suspense fallback={<p>Loading panel...</p>}>
      <LazyPanel />
    </Suspense>
  );
});
```

## Notes

- `setup` runs once per component instance, and should return a render function (`() => ReactNode`).
- Primitives also work outside components using a default global reactive scope.
- Use `createRoot(...)` when you need an isolated disposable non-React scope.
- For SSR, avoid implicit globals: create primitives inside components or inside `createRoot(...)` per request.
- Reads inside the render function are tracked and trigger rerenders.
- Reads inside `createMemo` and effects are tracked and rerun when dependencies change.
- `createStore` is immutable-by-default (`setStore` updates), while `createMutable` and `createReactiveArray` allow direct mutation.
- React `lazy`/`Suspense` already work as-is; this package also re-exports compatible helpers so usage style stays consistent.
- `createProjection` keeps a stable mutable reference and applies granular mutations, useful for large list projections.
- `createArrayProjection` gives keyed move/insert/remove updates for projected arrays without full replacement.
- `createLinkedSignal` is a writable derived signal: user overrides persist until the source derivation changes.
- This gives Solid-like authoring ergonomics, but still follows React rendering semantics.

## Releasing

- Local bump helpers:
  - `npm run release:patch`
  - `npm run release:minor`
  - `npm run release:major`
- Release PR automation: `.github/workflows/release-please.yml`
  - Uses `googleapis/release-please-action` on `main`/`master` pushes.
  - Opens/updates a release PR from Conventional Commit history.
  - Merging that PR creates the GitHub release + tag.
- Publish automation: `.github/workflows/publish-npm.yml`
  - Runs when a GitHub release is published.
  - Checks out the release tag, runs tests/build, and publishes to npm.
  - Uses repository secret `NPM_TOKEN` (mapped to `NODE_AUTH_TOKEN`).
