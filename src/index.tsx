import * as React from "react";
import { atom, createStore as createJotaiStore, type PrimitiveAtom } from "jotai/vanilla";
import type { Store } from "jotai/vanilla/store";

type Unsubscribe = () => void;
type Subscriber = () => void;
type Cleanup = () => void;

interface Subscribable {
  subscribe(callback: Subscriber): Unsubscribe;
}

interface DependencyCollector {
  addDependency(dep: Subscribable): void;
}

const collectorStack: DependencyCollector[] = [];
let batchDepth = 0;
const pendingSubscribers = new Set<Subscriber>();

function notifySubscriber(subscriber: Subscriber): void {
  if (batchDepth > 0) {
    pendingSubscribers.add(subscriber);
    return;
  }
  subscriber();
}

function flushSubscribers(): void {
  while (pendingSubscribers.size > 0) {
    const queued = Array.from(pendingSubscribers);
    pendingSubscribers.clear();
    for (const subscriber of queued) {
      subscriber();
    }
  }
}

function currentCollector(): DependencyCollector | undefined {
  return collectorStack[collectorStack.length - 1];
}

function pushCollector(collector: DependencyCollector): void {
  collectorStack.push(collector);
}

function popCollector(): void {
  collectorStack.pop();
}

function trackDependency(dep: Subscribable): void {
  currentCollector()?.addDependency(dep);
}

class DependencyTracker implements DependencyCollector {
  private subscriptions = new Map<Subscribable, Unsubscribe>();
  private collecting = new Set<Subscribable>();

  constructor(private readonly onDependencyChange: Subscriber) {}

  addDependency(dep: Subscribable): void {
    this.collecting.add(dep);
  }

  collect<T>(fn: () => T): T {
    this.collecting = new Set<Subscribable>();
    pushCollector(this);
    try {
      return fn();
    } finally {
      popCollector();
      this.reconcileSubscriptions(this.collecting);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
  }

  private reconcileSubscriptions(nextDeps: Set<Subscribable>): void {
    for (const [dep, unsubscribe] of this.subscriptions) {
      if (!nextDeps.has(dep)) {
        unsubscribe();
        this.subscriptions.delete(dep);
      }
    }

    for (const dep of nextDeps) {
      if (!this.subscriptions.has(dep)) {
        const unsubscribe = dep.subscribe(this.onDependencyChange);
        this.subscriptions.set(dep, unsubscribe);
      }
    }
  }
}

class Scope {
  readonly store: Store = createJotaiStore();

  private readonly disposables = new Set<{ dispose(): void }>();
  private readonly scopeCleanups = new Set<Cleanup>();
  private readonly layoutStarters: Array<() => void> = [];
  private readonly effectStarters: Array<() => void> = [];
  private layoutStarted = false;
  private effectsStarted = false;

  register(disposable: { dispose(): void }): void {
    this.disposables.add(disposable);
  }

  registerCleanup(cleanup: Cleanup): void {
    this.scopeCleanups.add(cleanup);
  }

  registerLayoutStarter(starter: () => void): void {
    if (this.layoutStarted) {
      starter();
      return;
    }
    this.layoutStarters.push(starter);
  }

  registerEffectStarter(starter: () => void): void {
    if (this.effectsStarted) {
      starter();
      return;
    }
    this.effectStarters.push(starter);
  }

  startLayoutEffects(): void {
    if (this.layoutStarted) {
      return;
    }
    this.layoutStarted = true;
    for (const starter of this.layoutStarters) {
      starter();
    }
    this.layoutStarters.length = 0;
  }

  startEffects(): void {
    if (this.effectsStarted) {
      return;
    }
    this.effectsStarted = true;
    for (const starter of this.effectStarters) {
      starter();
    }
    this.effectStarters.length = 0;
  }

  dispose(): void {
    for (const cleanup of this.scopeCleanups) {
      cleanup();
    }
    this.scopeCleanups.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.clear();
  }
}

const scopeStack: Scope[] = [];

function withScope<T>(scope: Scope, fn: () => T): T {
  scopeStack.push(scope);
  try {
    return fn();
  } finally {
    scopeStack.pop();
  }
}

function activeScope(): Scope {
  const scope = scopeStack[scopeStack.length - 1];
  if (!scope) {
    throw new Error(
      "No active reactive scope. Wrap your component with component(...) before calling reactive APIs.",
    );
  }
  return scope;
}

class SignalSource<T> implements Subscribable {
  private readonly signalAtom: PrimitiveAtom<T>;
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly store: Store, initialValue: T) {
    this.signalAtom = atom(initialValue);
  }

  get(): T {
    trackDependency(this);
    return this.store.get(this.signalAtom);
  }

  peek(): T {
    return this.store.get(this.signalAtom);
  }

  set(nextValue: T | ((prev: T) => T)): T {
    const previous = this.store.get(this.signalAtom);
    const resolvedValue =
      typeof nextValue === "function"
        ? (nextValue as (prev: T) => T)(previous)
        : nextValue;

    this.store.set(this.signalAtom, resolvedValue);

    if (!Object.is(previous, resolvedValue)) {
      for (const subscriber of this.subscribers) {
        notifySubscriber(subscriber);
      }
    }

    return resolvedValue;
  }

  subscribe(callback: Subscriber): Unsubscribe {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
}

class MemoSource<T> implements Subscribable {
  private readonly tracker: DependencyTracker;
  private readonly subscribers = new Set<Subscriber>();
  private hasValue = false;
  private value!: T;
  private computing = false;

  constructor(private readonly compute: () => T) {
    this.tracker = new DependencyTracker(() => {
      this.recompute();
    });
  }

  get(): T {
    trackDependency(this);
    if (!this.hasValue) {
      this.recompute();
    }
    return this.value;
  }

  subscribe(callback: Subscriber): Unsubscribe {
    this.subscribers.add(callback);
    if (!this.hasValue) {
      this.recompute();
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  dispose(): void {
    this.tracker.dispose();
    this.subscribers.clear();
  }

  private recompute(): void {
    if (this.computing) {
      return;
    }

    this.computing = true;
    try {
      const nextValue = this.tracker.collect(this.compute);
      const changed = !this.hasValue || !Object.is(this.value, nextValue);
      this.value = nextValue;
      this.hasValue = true;

      if (changed) {
        for (const subscriber of this.subscribers) {
          notifySubscriber(subscriber);
        }
      }
    } finally {
      this.computing = false;
    }
  }
}

let activeEffect: EffectComputation | null = null;

class EffectComputation {
  private readonly tracker: DependencyTracker;
  private scheduled = false;
  private running = false;
  private disposed = false;
  private cleanups: Cleanup[] = [];

  constructor(private readonly effect: () => void | Cleanup) {
    this.tracker = new DependencyTracker(() => {
      this.schedule();
    });
  }

  start(): void {
    this.schedule();
  }

  registerCleanup(cleanup: Cleanup): void {
    this.cleanups.push(cleanup);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runCleanups();
    this.tracker.dispose();
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      this.scheduled = true;
      return;
    }
    this.execute();
  }

  private execute(): void {
    if (this.disposed) {
      return;
    }

    this.running = true;
    this.scheduled = false;
    this.runCleanups();

    const previousEffect = activeEffect;
    activeEffect = this;

    try {
      const maybeCleanup = this.tracker.collect(this.effect);
      if (typeof maybeCleanup === "function") {
        this.cleanups.push(maybeCleanup);
      }
    } finally {
      activeEffect = previousEffect;
      this.running = false;
    }

    if (this.scheduled) {
      this.execute();
    }
  }

  private runCleanups(): void {
    const pending = this.cleanups;
    this.cleanups = [];
    for (const cleanup of pending) {
      cleanup();
    }
  }
}

/**
 * Read-only reactive getter.
 *
 * @example
 * ```ts
 * const [count] = createSignal(1)
 * const value: number = count()
 * ```
 */
export type Accessor<T> = () => T;

/**
 * Reactive setter that accepts either a value or updater function.
 *
 * @example
 * ```ts
 * const [, setCount] = createSignal(1)
 * setCount((n) => n + 1)
 * ```
 */
export type Setter<T> = (nextValue: T | ((prev: T) => T)) => T;

/**
 * Setter shape compatible with Solid's `createSignal` setter.
 *
 * @example
 * ```ts
 * const set: SolidSetter<number> = (next) => next
 * ```
 */
export type SolidSetter<T> = (nextValue: T | ((prev: T) => T)) => unknown;

/**
 * Tuple shape compatible with Solid's signal pair.
 *
 * @example
 * ```ts
 * const pair: SolidSignal<number> = [() => 1, (next) => next]
 * ```
 */
export type SolidSignal<T> = readonly [Accessor<T>, SolidSetter<T>];

/**
 * Async resource lifecycle states.
 *
 * @example
 * ```ts
 * if (user.state() === "ready") {
 *   // render user
 * }
 * ```
 */
export type ResourceState = "unresolved" | "pending" | "ready" | "errored";

/**
 * Read function for async resources with state metadata.
 *
 * @example
 * ```ts
 * const [user] = createResource(fetchUser)
 * if (user.loading()) return "Loading"
 * return user()?.name
 * ```
 */
export type ResourceAccessor<T> = Accessor<T | undefined> & {
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<unknown>;
  readonly latest: Accessor<T | undefined>;
  readonly state: Accessor<ResourceState>;
};

/**
 * Imperative controls returned by {@link createResource}.
 *
 * @example
 * ```ts
 * const [, controls] = createResource(fetchUsers)
 * controls.refetch()
 * ```
 */
export type ResourceControls<T> = {
  mutate: Setter<T | undefined>;
  refetch: () => void;
};

/**
 * Options for async resources.
 *
 * @example
 * ```ts
 * const [user] = createResource(fetchUser, { initialValue: cachedUser })
 * ```
 */
export type ResourceOptions<T> = {
  initialValue?: T;
};

/**
 * Creates a writable signal.
 *
 * @param initialValue Initial value stored in the signal.
 * @returns Tuple of `[getter, setter]`.
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0)
 * setCount((n) => n + 1)
 * ```
 */
export function createSignal<T>(initialValue: T): [Accessor<T>, Setter<T>] {
  const scope = activeScope();
  const source = new SignalSource(scope.store, initialValue);
  return [
    () => source.get(),
    (nextValue) => source.set(nextValue),
  ];
}

/**
 * Alias for {@link createSignal}.
 *
 * @example
 * ```ts
 * const [count, setCount] = signal(0)
 * ```
 */
export const signal = createSignal;

/**
 * Adapts a Solid-compatible signal pair into this library's strict setter shape.
 *
 * @param solidSignal Signal tuple `[get, set]` from Solid or compatible runtimes.
 * @returns Tuple `[get, set]` where `set` returns the current value.
 *
 * @example
 * ```ts
 * const [count, setCount] = fromSolidSignal(otherSignal)
 * setCount((n) => n + 1)
 * ```
 */
export function fromSolidSignal<T>(solidSignal: SolidSignal<T>): [Accessor<T>, Setter<T>] {
  const [get, set] = solidSignal;
  const normalizedSet: Setter<T> = (nextValue) => {
    set(nextValue);
    return get();
  };
  return [get, normalizedSet];
}

/**
 * Adapts this library's signal pair to a Solid-compatible tuple shape.
 *
 * @param reactiveSignal Tuple `[get, set]` from this library.
 * @returns Solid-compatible signal tuple.
 *
 * @example
 * ```ts
 * const solidPair = toSolidSignal(createSignal(0))
 * ```
 */
export function toSolidSignal<T>(
  reactiveSignal: readonly [Accessor<T>, Setter<T>],
): SolidSignal<T> {
  const [get, set] = reactiveSignal;
  const solidSetter: SolidSetter<T> = (nextValue) => {
    set(nextValue);
  };
  return [get, solidSetter] as const;
}

/**
 * Alias for {@link fromSolidSignal}.
 */
export const fromSignal = fromSolidSignal;

/**
 * Alias for {@link toSolidSignal}.
 */
export const toSignal = toSolidSignal;

/**
 * Creates a cached derived accessor.
 *
 * @param compute Derivation function. Reads inside this function become dependencies.
 * @returns Read-only accessor for the derived value.
 *
 * @example
 * ```ts
 * const total = createMemo(() => items().length)
 * ```
 */
export function createMemo<T>(compute: () => T): Accessor<T> {
  const scope = activeScope();
  const source = new MemoSource(compute);
  scope.register(source);
  return () => source.get();
}

/**
 * Alias for {@link createMemo}.
 *
 * @example
 * ```ts
 * const total = memo(() => items().length)
 * ```
 */
export const memo = createMemo;

/**
 * Registers an effect that runs after React commit.
 *
 * @param effect Effect callback. Return a cleanup function to dispose previous run resources.
 *
 * @example
 * ```ts
 * createEffect(() => {
 *   console.log(count())
 * })
 * ```
 */
export function createEffect(effect: () => void | Cleanup): void {
  const scope = activeScope();
  const computation = new EffectComputation(effect);
  scope.register(computation);
  scope.registerEffectStarter(() => {
    computation.start();
  });
}

/**
 * Alias for {@link createEffect}.
 *
 * @example
 * ```ts
 * effect(() => console.log(count()))
 * ```
 */
export const effect = createEffect;

/**
 * Registers an effect that runs in layout phase.
 *
 * @param effect Layout effect callback. Return a cleanup function to dispose previous run resources.
 *
 * @example
 * ```ts
 * createLayoutEffect(() => {
 *   measureLayout()
 * })
 * ```
 */
export function createLayoutEffect(effect: () => void | Cleanup): void {
  const scope = activeScope();
  const computation = new EffectComputation(effect);
  scope.register(computation);
  scope.registerLayoutStarter(() => {
    computation.start();
  });
}

/**
 * Alias for {@link createLayoutEffect}.
 *
 * @example
 * ```ts
 * layoutEffect(() => measure())
 * ```
 */
export const layoutEffect = createLayoutEffect;

/**
 * Creates a reactive computation for side effects.
 * Alias of {@link createEffect} for Solid-style API compatibility.
 *
 * @param compute Side-effect function.
 *
 * @example
 * ```ts
 * createComputed(() => {
 *   syncExternalStore(count())
 * })
 * ```
 */
export function createComputed(compute: () => void | Cleanup): void {
  createEffect(compute);
}

/**
 * Alias for {@link createComputed}.
 *
 * @example
 * ```ts
 * computed(() => sync(count()))
 * ```
 */
export const computed = createComputed;

/**
 * Runs a callback once on mount and disposes it on unmount if cleanup is returned.
 *
 * @param callback Mount callback.
 *
 * @example
 * ```ts
 * onMount(() => {
 *   const ws = connect()
 *   return () => ws.close()
 * })
 * ```
 */
export function onMount(callback: () => void | Cleanup): void {
  createEffect(() => {
    const maybeCleanup = untrack(callback);
    if (typeof maybeCleanup === "function") {
      onCleanup(maybeCleanup);
    }
  });
}

/**
 * Alias for {@link onMount}.
 *
 * @example
 * ```ts
 * mount(() => console.log("mounted"))
 * ```
 */
export const mount = onMount;

/**
 * Registers cleanup in setup scope or currently running effect.
 *
 * @param cleanup Cleanup callback invoked on re-run or scope disposal.
 *
 * @example
 * ```ts
 * createEffect(() => {
 *   const id = setInterval(tick, 1000)
 *   onCleanup(() => clearInterval(id))
 * })
 * ```
 */
export function onCleanup(cleanup: Cleanup): void {
  if (activeEffect) {
    activeEffect.registerCleanup(cleanup);
    return;
  }

  const scope = scopeStack[scopeStack.length - 1];
  if (scope) {
    scope.registerCleanup(cleanup);
    return;
  }

  throw new Error("onCleanup must run inside component setup or an effect.");
}

/**
 * Alias for {@link onCleanup}.
 *
 * @example
 * ```ts
 * cleanup(() => console.log("disposed"))
 * ```
 */
export const cleanup = onCleanup;

/**
 * Batches reactive notifications and flushes once at the end.
 *
 * @param fn Function containing grouped signal/store writes.
 * @returns Result of `fn()`.
 *
 * @example
 * ```ts
 * batch(() => {
 *   setFirst("Ada")
 *   setLast("Lovelace")
 * })
 * ```
 */
export function batch<T>(fn: () => T): T {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) {
      flushSubscribers();
    }
  }
}

/**
 * Executes a function without dependency tracking.
 *
 * @param fn Function to execute without capturing dependencies.
 * @returns Result of `fn()`.
 *
 * @example
 * ```ts
 * const stable = untrack(() => expensiveSnapshot())
 * ```
 */
export function untrack<T>(fn: () => T): T {
  const previous = collectorStack.pop();
  try {
    return fn();
  } finally {
    if (previous) {
      collectorStack.push(previous);
    }
  }
}

type ResourceFetcher<T, S> =
  | ((source: S, info: { value: T | undefined; refetching: boolean }) => Promise<T> | T)
  | (() => Promise<T> | T);

function resolveResourceArgs<T, S>(
  sourceOrFetcher: Accessor<S> | ResourceFetcher<T, S>,
  maybeFetcher?: ResourceFetcher<T, S>,
  maybeOptions?: ResourceOptions<T>,
): {
  source: Accessor<S> | null;
  fetcher: ResourceFetcher<T, S>;
  options: ResourceOptions<T>;
} {
  if (maybeFetcher) {
    return {
      source: sourceOrFetcher as Accessor<S>,
      fetcher: maybeFetcher,
      options: maybeOptions ?? {},
    };
  }

  return {
    source: null,
    fetcher: sourceOrFetcher as ResourceFetcher<T, S>,
    options: maybeOptions ?? {},
  };
}

/**
 * Creates an async resource from a fetcher.
 *
 * @param fetcher Async or sync function that resolves the resource value.
 * @param options Optional resource options such as `initialValue`.
 * @returns Tuple of `[resourceAccessor, controls]`.
 *
 * @example
 * ```ts
 * const [users, { refetch }] = createResource(async () => fetchUsers())
 * refetch()
 * ```
 */
export function createResource<T>(
  fetcher: () => Promise<T> | T,
  options?: ResourceOptions<T>,
): [
  ResourceAccessor<T>,
  ResourceControls<T>,
];

/**
 * Creates an async resource that re-fetches when `source()` changes.
 *
 * @param source Source accessor. When this value changes, the resource refetches.
 * @param fetcher Fetcher receiving source value and refetch metadata.
 * @param options Optional resource options such as `initialValue`.
 * @returns Tuple of `[resourceAccessor, controls]`.
 *
 * @example
 * ```ts
 * const [user] = createResource(id, (value) => fetchUser(value))
 * ```
 */
export function createResource<S, T>(
  source: Accessor<S>,
  fetcher: (source: S, info: { value: T | undefined; refetching: boolean }) => Promise<T> | T,
  options?: ResourceOptions<T>,
): [
  ResourceAccessor<T>,
  ResourceControls<T>,
];
export function createResource<T, S>(
  sourceOrFetcher: Accessor<S> | ResourceFetcher<T, S>,
  maybeFetcher?: ResourceFetcher<T, S> | ResourceOptions<T>,
  maybeOptions?: ResourceOptions<T>,
): [
  ResourceAccessor<T>,
  ResourceControls<T>,
] {
  const isSourceMode = typeof maybeFetcher === "function";
  const parsed = isSourceMode
    ? resolveResourceArgs(
        sourceOrFetcher as Accessor<S>,
        maybeFetcher as ResourceFetcher<T, S>,
        maybeOptions,
      )
    : resolveResourceArgs(
        sourceOrFetcher as ResourceFetcher<T, S>,
        undefined,
        maybeFetcher as ResourceOptions<T> | undefined,
      );

  const [value, setValue] = createSignal<T | undefined>(parsed.options.initialValue);
  const [latest, setLatest] = createSignal<T | undefined>(parsed.options.initialValue);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(undefined);
  const [state, setState] = createSignal<ResourceState>(
    parsed.options.initialValue === undefined ? "unresolved" : "ready",
  );
  const [refetchCount, setRefetchCount] = createSignal(0);

  let runId = 0;

  createEffect(() => {
    const sourceValue = parsed.source ? parsed.source() : undefined;
    const currentRefetchCount = refetchCount();
    const refetching = currentRefetchCount > 0;
    const requestId = ++runId;

    setLoading(true);
    setError(undefined);
    setState("pending");

    const execute = async (): Promise<void> => {
      try {
        const nextValue = parsed.source
          ? await (parsed.fetcher as (source: S, info: { value: T | undefined; refetching: boolean }) => Promise<T> | T)(
              sourceValue as S,
              { value: latest(), refetching },
            )
          : await (parsed.fetcher as () => Promise<T> | T)();

        if (requestId !== runId) {
          return;
        }

        setValue(nextValue);
        setLatest(nextValue);
        setState("ready");
      } catch (nextError) {
        if (requestId !== runId) {
          return;
        }

        setError(nextError);
        setState("errored");
      } finally {
        if (requestId === runId) {
          setLoading(false);
        }
      }
    };

    void execute();
  });

  const resource = (() => value()) as ResourceAccessor<T>;
  Object.defineProperties(resource, {
    loading: {
      value: () => loading(),
      enumerable: true,
    },
    error: {
      value: () => error(),
      enumerable: true,
    },
    latest: {
      value: () => latest(),
      enumerable: true,
    },
    state: {
      value: () => state(),
      enumerable: true,
    },
  });

  return [
    resource,
    {
      mutate: setValue,
      refetch: () => {
        setRefetchCount((n) => n + 1);
      },
    },
  ];
}

/**
 * Alias for {@link createResource}.
 *
 * @example
 * ```ts
 * const [user] = resource(() => fetchUser())
 * ```
 */
export const resource = createResource;

/**
 * Shortcut for `createResource(fetcher)[0]`.
 *
 * @param compute Async or sync function that resolves the value.
 * @param options Optional resource options such as `initialValue`.
 * @returns Resource accessor only.
 *
 * @example
 * ```ts
 * const profile = createAsync(() => fetchProfile())
 * ```
 */
export function createAsync<T>(
  compute: () => Promise<T> | T,
  options?: ResourceOptions<T>,
): ResourceAccessor<T> {
  const [resource] = createResource(compute, options);
  return resource;
}

/**
 * Alias for {@link createAsync}.
 *
 * @example
 * ```ts
 * const profile = asyncSignal(() => fetchProfile())
 * ```
 */
export const asyncSignal = createAsync;

const promiseState = new WeakMap<PromiseLike<unknown>, {
  status: "pending" | "resolved" | "rejected";
  value?: unknown;
  error?: unknown;
}>();

/**
 * Reads an accessor value or unwraps a promise in Suspense context.
 *
 * @param value Accessor or thenable/promise value.
 * @returns Current accessor value or resolved promise value.
 *
 * @example
 * ```tsx
 * const value = use(() => count())
 * const data = use(fetchPromise)
 * ```
 */
export function use<T>(value: Accessor<T>): T;
export function use<T>(value: PromiseLike<T>): T;
export function use<T>(value: Accessor<T> | PromiseLike<T>): T {
  if (typeof value === "function") {
    return (value as Accessor<T>)();
  }

  const existing = promiseState.get(value as PromiseLike<unknown>);
  if (!existing) {
    const state = { status: "pending" as const };
    promiseState.set(value as PromiseLike<unknown>, state);
    Promise.resolve(value).then(
      (resolvedValue) => {
        promiseState.set(value as PromiseLike<unknown>, {
          status: "resolved",
          value: resolvedValue,
        });
      },
      (rejectedError) => {
        promiseState.set(value as PromiseLike<unknown>, {
          status: "rejected",
          error: rejectedError,
        });
      },
    );
    throw value;
  }

  if (existing.status === "pending") {
    throw value;
  }
  if (existing.status === "rejected") {
    throw existing.error;
  }

  return existing.value as T;
}

type PathSegment = string | number | symbol;

const MUTATING_ARRAY_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function shallowClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }
  if (isObjectLike(value)) {
    return { ...(value as object) } as T;
  }
  return value;
}

function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isObjectLike(cursor) && !Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

function setAtPath<T>(root: T, path: readonly PathSegment[], value: unknown): T {
  if (path.length === 0) {
    return value as T;
  }

  const [head, ...tail] = path;
  const clone = shallowClone(root);
  const container = clone as Record<PropertyKey, unknown>;
  const currentValue = container[head];
  container[head] =
    tail.length === 0
      ? value
      : setAtPath(
          isObjectLike(currentValue) || Array.isArray(currentValue)
            ? currentValue
            : typeof tail[0] === "number"
              ? []
              : {},
          tail,
          value,
        );
  return clone;
}

function pathToKey(path: readonly PathSegment[]): string {
  return path
    .map((segment) =>
      typeof segment === "symbol" ? `s:${String(segment.description ?? "")}` : `k:${String(segment)}`,
    )
    .join("|");
}

function createReactiveProxy<T extends object>(
  source: SignalSource<T>,
  mutable: boolean,
): T {
  const proxyCache = new Map<string, object>();

  const readNode = (path: readonly PathSegment[]) => getAtPath(source.get(), path);
  const peekNode = (path: readonly PathSegment[]) => getAtPath(source.peek(), path);

  const createAtPath = (path: readonly PathSegment[]): any => {
    const key = pathToKey(path);
    const cached = proxyCache.get(key);
    if (cached) {
      return cached;
    }

    const initialNode = peekNode(path);
    const target = Array.isArray(initialNode) ? [] : {};

    const proxy = new Proxy(target, {
      get(_target, prop) {
        const node = readNode(path);

        if (prop === Symbol.toStringTag && Array.isArray(node)) {
          return "Array";
        }

        if (!isObjectLike(node) && !Array.isArray(node)) {
          return undefined;
        }

        if (
          mutable &&
          Array.isArray(node) &&
          typeof prop === "string" &&
          MUTATING_ARRAY_METHODS.has(prop)
        ) {
          return (...args: unknown[]) => {
            const previousRoot = source.peek();
            const currentArray = getAtPath(previousRoot, path);
            if (!Array.isArray(currentArray)) {
              return undefined;
            }

            const nextArray = [...currentArray];
            const method = (nextArray as unknown as Record<string, (...params: unknown[]) => unknown>)[prop];
            const result = method.apply(nextArray, args);
            const nextRoot = setAtPath(previousRoot, path, nextArray);
            source.set(nextRoot);
            return result;
          };
        }

        const value = (node as Record<PropertyKey, unknown>)[prop];

        if (Array.isArray(node) && prop === Symbol.iterator) {
          return (value as (...args: unknown[]) => unknown).bind(node);
        }

        if (isObjectLike(value) || Array.isArray(value)) {
          return createAtPath([...path, prop]);
        }

        if (typeof value === "function") {
          return (value as (...args: unknown[]) => unknown).bind(node);
        }

        return value;
      },
      set(_target, prop, value) {
        if (!mutable) {
          throw new Error("Cannot mutate immutable store. Use setStore instead.");
        }

        const previousRoot = source.peek();
        const nextRoot = setAtPath(previousRoot, [...path, prop], value);
        source.set(nextRoot);
        return true;
      },
      deleteProperty(_target, prop) {
        if (!mutable) {
          throw new Error("Cannot mutate immutable store. Use setStore instead.");
        }

        const previousRoot = source.peek();
        const node = getAtPath(previousRoot, path);
        if (!isObjectLike(node) && !Array.isArray(node)) {
          return true;
        }

        const clone = shallowClone(node) as Record<PropertyKey, unknown>;
        delete clone[prop];
        source.set(setAtPath(previousRoot, path, clone));
        return true;
      },
      ownKeys() {
        const node = readNode(path);
        if (!isObjectLike(node) && !Array.isArray(node)) {
          return [];
        }
        return Reflect.ownKeys(node);
      },
      getOwnPropertyDescriptor(_target, prop) {
        const node = readNode(path);
        if (!isObjectLike(node) && !Array.isArray(node)) {
          return undefined;
        }

        const descriptor = Object.getOwnPropertyDescriptor(node, prop);
        if (!descriptor) {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: undefined,
          };
        }

        return {
          ...descriptor,
          configurable: true,
        };
      },
      has(_target, prop) {
        const node = readNode(path);
        if (!isObjectLike(node) && !Array.isArray(node)) {
          return false;
        }
        return prop in node;
      },
    });

    proxyCache.set(key, proxy);
    return proxy;
  };

  return createAtPath([]) as T;
}

/**
 * Setter for immutable stores.
 *
 * @example
 * ```ts
 * setStore({ filter: "active" })
 * setStore((prev) => ({ count: prev.count + 1 }))
 * ```
 */
export type SetStore<T> = (next: T | Partial<T> | ((prev: T) => T | Partial<T>)) => T;

/**
 * Creates an immutable reactive object store.
 *
 * @param initialValue Initial object state.
 * @returns Tuple of `[storeProxy, setStore]`.
 *
 * @example
 * ```ts
 * const [store, setStore] = createStore({ count: 0 })
 * setStore({ count: 1 })
 * ```
 */
export function createStore<T extends object>(initialValue: T): [T, SetStore<T>] {
  const scope = activeScope();
  const source = new SignalSource(scope.store, initialValue);
  const store = createReactiveProxy(source, false);

  const setStore: SetStore<T> = (next) => {
    const previous = source.peek();
    const resolved = typeof next === "function" ? (next as (prev: T) => T | Partial<T>)(previous) : next;
    const merged =
      isObjectLike(previous) && isObjectLike(resolved)
        ? ({ ...(previous as object), ...(resolved as object) } as T)
        : (resolved as T);
    return source.set(merged);
  };

  return [store, setStore];
}

/**
 * Alias for {@link createStore}.
 *
 * @example
 * ```ts
 * const [state, setState] = store({ count: 0 })
 * ```
 */
export const store = createStore;

/**
 * Typo-friendly alias for {@link createStore}.
 *
 * @example
 * ```ts
 * const [state, setState] = sotre({ count: 0 })
 * ```
 */
export const sotre = createStore;

/**
 * Creates a mutable reactive object.
 *
 * @param initialValue Initial object state.
 * @returns Mutable reactive proxy.
 *
 * @example
 * ```ts
 * const state = createMutable({ count: 0 })
 * state.count += 1
 * ```
 */
export function createMutable<T extends object>(initialValue: T): T {
  const scope = activeScope();
  const source = new SignalSource(scope.store, initialValue);
  return createReactiveProxy(source, true);
}

/**
 * Alias for {@link createMutable}.
 *
 * @example
 * ```ts
 * const state = mutable({ count: 0 })
 * ```
 */
export const mutable = createMutable;

/**
 * Alias for {@link createMutable}.
 *
 * @param initialValue Initial object state.
 * @returns Mutable reactive proxy.
 *
 * @example
 * ```ts
 * const state = createMutableStore({ value: 1 })
 * ```
 */
export function createMutableStore<T extends object>(initialValue: T): T {
  return createMutable(initialValue);
}

/**
 * Creates a mutable reactive array.
 *
 * @param initialValue Initial list values.
 * @returns Mutable reactive array proxy.
 *
 * @example
 * ```ts
 * const list = createReactiveArray([1, 2])
 * list.push(3)
 * ```
 */
export function createReactiveArray<T>(initialValue: T[] = []): T[] {
  return createMutable(initialValue);
}

/**
 * Alias for {@link createReactiveArray}.
 *
 * @param initialValue Initial list values.
 * @returns Mutable reactive array proxy.
 *
 * @example
 * ```ts
 * const list = createArrayStore(["a"])
 * ```
 */
export function createArrayStore<T>(initialValue: T[] = []): T[] {
  return createReactiveArray(initialValue);
}

/**
 * Options for keyed array projections.
 *
 * @example
 * ```ts
 * const rows = createArrayProjection(items, {
 *   key: (item) => item.id,
 *   map: (item) => ({ ...item }),
 * })
 * ```
 */
export type ArrayProjectionOptions<SourceItem, ProjectedItem, Key = unknown> = {
  key?: (item: SourceItem, index: number) => Key;
  map: (item: SourceItem, index: number) => ProjectedItem;
  update?: (projected: ProjectedItem, item: SourceItem, index: number) => void;
};

/**
 * Creates a stable projected array with keyed move/insert/remove updates.
 *
 * @param source Source list accessor to project from.
 * @param options Projection behavior (`key`, `map`, optional `update`).
 * @returns Stable mutable projected array.
 *
 * @example
 * ```ts
 * const rows = createArrayProjection(users, {
 *   key: (u) => u.id,
 *   map: (u) => ({ id: u.id, name: u.name }),
 *   update: (row, u) => { row.name = u.name },
 * })
 * ```
 */
export function createArrayProjection<SourceItem, ProjectedItem, Key = unknown>(
  source: Accessor<readonly SourceItem[] | null | undefined>,
  options: ArrayProjectionOptions<SourceItem, ProjectedItem, Key>,
): ProjectedItem[] {
  const keyFn = options.key ?? ((_: SourceItem, index: number) => index as unknown as Key);
  let keys: Key[] = [];

  return createProjection(
    source,
    (initialSource) => {
      const list = initialSource ?? [];
      keys = list.map((item, index) => keyFn(item, index));
      return list.map((item, index) => options.map(item, index));
    },
    (target, nextSource) => {
      const list = nextSource ?? [];
      const nextKeys = list.map((item, index) => keyFn(item, index));

      for (let index = 0; index < list.length; index += 1) {
        const nextKey = nextKeys[index];

        if (index < keys.length && Object.is(keys[index], nextKey)) {
          if (options.update) {
            options.update(target[index] as ProjectedItem, list[index] as SourceItem, index);
          }
          continue;
        }

        let foundIndex = -1;
        for (let cursor = index + 1; cursor < keys.length; cursor += 1) {
          if (Object.is(keys[cursor], nextKey)) {
            foundIndex = cursor;
            break;
          }
        }

        if (foundIndex >= 0) {
          const [movedItem] = target.splice(foundIndex, 1);
          const [movedKey] = keys.splice(foundIndex, 1);
          target.splice(index, 0, movedItem as ProjectedItem);
          keys.splice(index, 0, movedKey as Key);

          if (options.update) {
            options.update(target[index] as ProjectedItem, list[index] as SourceItem, index);
          }
          continue;
        }

        const projected = options.map(list[index] as SourceItem, index);
        target.splice(index, 0, projected);
        keys.splice(index, 0, nextKey);
      }

      while (target.length > list.length) {
        target.pop();
      }
      while (keys.length > list.length) {
        keys.pop();
      }
    },
  );
}

/**
 * Alias for {@link createArrayProjection}.
 *
 * @example
 * ```ts
 * const rows = arrayProjection(items, { map: (i) => i })
 * ```
 */
export const arrayProjection = createArrayProjection;

/**
 * Writable derived signal state returned by {@link createLinkedSignal}.
 *
 * @example
 * ```ts
 * const selected = createLinkedSignal(() => items()[0]?.id ?? null)
 * selected.set("abc")
 * ```
 */
export type LinkedSignalState<T> = {
  readonly value: Accessor<T>;
  readonly set: Setter<T>;
  readonly reset: () => T;
  readonly isOverridden: Accessor<boolean>;
};

/**
 * Creates a writable derived signal that resets when derivation inputs change.
 *
 * @param derive Function that computes the default value from reactive dependencies.
 * @returns Linked signal state with `value`, `set`, `reset`, and `isOverridden`.
 *
 * @example
 * ```ts
 * const selected = createLinkedSignal(() => items()[0]?.id ?? null)
 * selected.set("custom")
 * ```
 */
export function createLinkedSignal<T>(derive: () => T): LinkedSignalState<T> {
  const [value, setValue] = createSignal(untrack(derive));
  const [isOverridden, setIsOverridden] = createSignal(false);

  createEffect(() => {
    const nextDefault = derive();
    setValue(nextDefault);
    setIsOverridden(false);
  });

  const set: Setter<T> = (next) => {
    setIsOverridden(true);
    return setValue(next);
  };

  const reset = (): T => {
    const nextDefault = untrack(derive);
    setIsOverridden(false);
    return setValue(nextDefault);
  };

  return {
    value,
    set,
    reset,
    isOverridden,
  };
}

/**
 * Alias for {@link createLinkedSignal}.
 *
 * @example
 * ```ts
 * const selected = linkedSignal(() => "default")
 * ```
 */
export const linkedSignal = createLinkedSignal;

type ProjectionMutator<Source, Target> = (
  target: Target,
  source: Source,
  previousSource: Source,
) => void;

/**
 * Creates a mutable projection with a stable reference.
 *
 * @param source Source accessor that drives projection updates.
 * @param initialize Initializes projection state from the first source value.
 * @param mutate Applies granular updates to the existing projection object.
 * @returns Stable mutable projection object.
 *
 * @example
 * ```ts
 * const projection = createProjection(source, (s) => ({ ...s }), (target, next) => {
 *   Object.assign(target, next)
 * })
 * ```
 */
export function createProjection<Source, Target extends object>(
  source: Accessor<Source>,
  initialize: (source: Source) => Target,
  mutate: ProjectionMutator<Source, Target>,
): Target {
  const firstSource = source();
  const projected = createMutable(initialize(firstSource));
  let previousSource = firstSource;

  createEffect(() => {
    const nextSource = source();
    untrack(() => {
      mutate(projected, nextSource, previousSource);
    });
    previousSource = nextSource;
  });

  return projected;
}

/**
 * Alias for {@link createProjection}.
 *
 * @example
 * ```ts
 * const state = projection(source, (s) => ({ ...s }), (t, s) => Object.assign(t, s))
 * ```
 */
export const projection = createProjection;

/**
 * Re-export of `React.Suspense` for API consistency.
 *
 * @example
 * ```tsx
 * <Suspense fallback={<p>Loading...</p>}><View /></Suspense>
 * ```
 */
export const Suspense = React.Suspense;

/**
 * Wrapper around `React.lazy` that also accepts direct component loaders.
 *
 * @param loader Async loader returning either a module with default export or a component.
 * @returns Lazy React component suitable for Suspense boundaries.
 *
 * @example
 * ```ts
 * const Settings = lazy(() => import("./Settings"))
 * ```
 */
export function lazy<Props>(
  loader: () => Promise<{ default: React.ComponentType<Props> } | React.ComponentType<Props>>,
): React.LazyExoticComponent<React.ComponentType<Props>> {
  return React.lazy(async () => {
    const loaded = await loader();
    if (typeof loaded === "function") {
      return { default: loaded as React.ComponentType<Props> };
    }
    return loaded;
  });
}

type SetupResult = (() => React.ReactNode) | React.ReactNode;

type SetupFn<Props> = (props: Accessor<Readonly<Props>>) => SetupResult;
type SetupFnNoProps = () => SetupResult;

/**
 * Options for wrapped `component(...)` React components.
 *
 * @example
 * ```ts
 * const View = component(setup, { memo: true, displayName: "View" })
 * ```
 */
export type ComponentOptions<Props> = {
  memo?: boolean | ((prev: Readonly<Props>, next: Readonly<Props>) => boolean);
  displayName?: string;
};

/**
 * Public component type returned by {@link component}.
 *
 * @example
 * ```ts
 * const View: SolidComponent<{ id: string }> = component((props) => () => <p>{props().id}</p>)
 * ```
 */
export type SolidComponent<Props> = React.ComponentType<Props>;

class ComponentInstance<Props> {
  private readonly scope = new Scope();
  private readonly propsSource: SignalSource<Props>;
  private readonly renderTracker: DependencyTracker;
  private readonly render: () => React.ReactNode;
  private disposed = false;
  private suppressRenderInvalidation = false;

  constructor(
    initialProps: Props,
    setup: SetupFn<Props>,
    private readonly forceUpdate: () => void,
  ) {
    this.propsSource = new SignalSource(this.scope.store, initialProps);
    this.renderTracker = new DependencyTracker(() => {
      if (!this.suppressRenderInvalidation) {
        this.forceUpdate();
      }
    });
    this.scope.register(this.renderTracker);

    const result = withScope(this.scope, () =>
      setup(() => this.propsSource.get()),
    );

    this.render =
      typeof result === "function"
        ? (result as () => React.ReactNode)
        : () => result;
  }

  updateProps(nextProps: Props): void {
    this.suppressRenderInvalidation = true;
    try {
      this.propsSource.set(nextProps);
    } finally {
      this.suppressRenderInvalidation = false;
    }
  }

  renderNode(): React.ReactNode {
    return withScope(this.scope, () => this.renderTracker.collect(this.render));
  }

  startLayoutEffects(): void {
    this.scope.startLayoutEffects();
  }

  startEffects(): void {
    this.scope.startEffects();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.scope.dispose();
  }
}

/**
 * Wraps a setup function so Solid-style primitives can be used without custom hooks.
 *
 * @param setup Setup function that runs once per component instance.
 * @param options Wrapper options (`memo`, `displayName`).
 * @returns React function component.
 *
 * @example
 * ```tsx
 * const Counter = component(() => {
 *   const [count, setCount] = createSignal(0)
 *   return () => <button onClick={() => setCount((n) => n + 1)}>{count()}</button>
 * })
 * ```
 */
export function component(
  setup: SetupFnNoProps,
  options?: ComponentOptions<Record<string, never>>,
): SolidComponent<Record<string, never>>;
export function component<Props>(
  setup: SetupFn<Props>,
  options?: ComponentOptions<Props>,
): SolidComponent<Props>;
/**
 * Wraps a setup function so Solid-style primitives can be used without custom hooks.
 *
 * Supports both setup styles:
 * - no-props: `component(() => () => <div />)`
 * - props accessor: `component<{ id: string }>((props) => () => <div>{props().id}</div>)`
 */
export function component<Props>(
  setup: SetupFn<Props> | SetupFnNoProps,
  options: ComponentOptions<Props> = {},
): SolidComponent<Props> {
  const normalizedSetup: SetupFn<Props> =
    setup.length === 0
      ? () => (setup as SetupFnNoProps)()
      : (setup as SetupFn<Props>);

  const Wrapped: React.FC<Props> = (props: Props) => {
    const [, setTick] = React.useState(0);
    const forceUpdate = React.useCallback(() => {
      setTick((tick: number) => tick + 1);
    }, []);

    const instanceRef = React.useRef<ComponentInstance<Props> | null>(null);

    if (!instanceRef.current) {
      instanceRef.current = new ComponentInstance(props, normalizedSetup, forceUpdate);
    }

    const instance = instanceRef.current;
    instance.updateProps(props);

    React.useLayoutEffect(() => {
      instance.startLayoutEffects();
      return () => {
        instance.dispose();
      };
    }, [instance]);

    React.useEffect(() => {
      instance.startEffects();
    }, [instance]);

    return <>{instance.renderNode()}</>;
  };

  const name = options.displayName ?? setup.name ?? "SolidLikeComponent";
  Wrapped.displayName = name;

  if (!options.memo) {
    return Wrapped;
  }

  const memoized =
    typeof options.memo === "function"
      ? React.memo(Wrapped, options.memo)
      : React.memo(Wrapped);
  memoized.displayName = name;
  return memoized;
}

/**
 * Alias for {@link component}.
 *
 * @example
 * ```ts
 * const View = defineComponent(() => <p>Hello</p>)
 * ```
 */
export const defineComponent = component;

/**
 * Utility union type accepted by control-flow primitives.
 *
 * @example
 * ```ts
 * const maybe = () => true
 * const value: MaybeAccessor<boolean> = maybe
 * ```
 */
export type MaybeAccessor<T> = T | Accessor<T>;

function readMaybeAccessor<T>(value: MaybeAccessor<T>): T {
  return resolveMaybeAccessor(value);
}

/**
 * Props for {@link Show}.
 *
 * @example
 * ```tsx
 * <Show when={user()} fallback={<p>No user</p>}>{(u) => <p>{u.name}</p>}</Show>
 * ```
 */
export type ShowProps<T> = {
  /** Condition value (or accessor). Truthy renders children, falsy renders fallback. */
  when: MaybeAccessor<T | null | undefined | false>;
  /** Content rendered when `when` is falsy. */
  fallback?: React.ReactNode;
  /** Reserved compatibility flag for Solid-style signatures. */
  keyed?: boolean;
  /** Render content or render function receiving narrowed truthy value. */
  children: React.ReactNode | ((value: NonNullable<T>) => React.ReactNode);
};

/**
 * Conditionally renders content when `when` is truthy.
 *
 * @param props Show control-flow props.
 * @returns Matching branch or fallback.
 *
 * @example
 * ```tsx
 * <Show when={ready()} fallback={<p>Loading</p>}><p>Ready</p></Show>
 * ```
 */
export function Show<T>(props: ShowProps<T>): React.ReactNode {
  const value = readMaybeAccessor(props.when);
  if (!value) {
    return props.fallback ?? null;
  }

  if (typeof props.children === "function") {
    return (props.children as (value: NonNullable<T>) => React.ReactNode)(
      value as NonNullable<T>,
    );
  }

  return props.children;
}

/**
 * Props for {@link For}.
 *
 * @example
 * ```tsx
 * <For each={items()}>{(item) => <li>{item.name}</li>}</For>
 * ```
 */
export type ForProps<T> = {
  /** Source list (or accessor) to iterate. */
  each: MaybeAccessor<readonly T[] | null | undefined>;
  /** Rendered when list is empty. */
  fallback?: React.ReactNode;
  /** Item renderer with stable index accessor. */
  children: (item: T, index: Accessor<number>) => React.ReactNode;
};

/**
 * Renders each item in a list.
 *
 * @param props For control-flow props.
 * @returns Rendered list or fallback.
 *
 * @example
 * ```tsx
 * <For each={todos()} fallback={<p>Empty</p>}>{(todo) => <p>{todo.title}</p>}</For>
 * ```
 */
export function For<T>(props: ForProps<T>): React.ReactNode {
  const list = readMaybeAccessor(props.each) ?? [];
  if (list.length === 0) {
    return props.fallback ?? null;
  }

  return (
    <>
      {list.map((item, index) => (
        <React.Fragment key={index}>
          {props.children(item, () => index)}
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * Props for {@link Index}.
 *
 * @example
 * ```tsx
 * <Index each={items()}>{(item) => <li>{item().name}</li>}</Index>
 * ```
 */
export type IndexProps<T> = {
  /** Source list (or accessor) to iterate. */
  each: MaybeAccessor<readonly T[] | null | undefined>;
  /** Rendered when list is empty. */
  fallback?: React.ReactNode;
  /** Item renderer with accessor per item and index accessor. */
  children: (item: Accessor<T>, index: Accessor<number>) => React.ReactNode;
};

/**
 * Renders a list where each child receives an item accessor.
 *
 * @param props Index control-flow props.
 * @returns Rendered list or fallback.
 *
 * @example
 * ```tsx
 * <Index each={rows()}>{(row) => <Row data={row()} />}</Index>
 * ```
 */
export function Index<T>(props: IndexProps<T>): React.ReactNode {
  const list = readMaybeAccessor(props.each) ?? [];
  if (list.length === 0) {
    return props.fallback ?? null;
  }

  return (
    <>
      {list.map((_, index) => (
        <React.Fragment key={index}>
          {props.children(() => list[index] as T, () => index)}
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * Props for {@link Match} used inside {@link Switch}.
 *
 * @example
 * ```tsx
 * <Match when={status() === "ready"}><Ready /></Match>
 * ```
 */
export type MatchProps<T> = {
  /** Match condition (or accessor). First truthy Match is selected by Switch. */
  when: MaybeAccessor<T | null | undefined | false>;
  /** Render content or render function receiving narrowed truthy match value. */
  children: React.ReactNode | ((value: NonNullable<T>) => React.ReactNode);
};

/**
 * Switch branch marker consumed by {@link Switch}.
 *
 * @param _props Match branch props consumed by `Switch`.
 * @returns `null` when rendered standalone.
 *
 * @example
 * ```tsx
 * <Switch><Match when={ok()}>OK</Match></Switch>
 * ```
 */
export function Match<T>(_props: MatchProps<T>): React.ReactElement | null {
  return null;
}

/**
 * Props for {@link Switch}.
 *
 * @example
 * ```tsx
 * <Switch fallback={<p>Unknown</p>}>...</Switch>
 * ```
 */
export type SwitchProps = {
  /** Content rendered when no Match branch is truthy. */
  fallback?: React.ReactNode;
  /** Match branches (typically Match components). */
  children?: React.ReactNode;
};

/**
 * Type guard for accessors.
 *
 * @param value Value to check.
 * @returns `true` when value is an accessor function.
 *
 * @example
 * ```ts
 * if (isAccessor(value)) {
 *   console.log(value())
 * }
 * ```
 */
export function isAccessor<T = unknown>(value: unknown): value is Accessor<T> {
  return typeof value === "function";
}

/**
 * Resolves plain values or accessors into a value.
 *
 * @param value Plain value or accessor.
 * @returns Resolved value.
 *
 * @example
 * ```ts
 * const enabled = resolveMaybeAccessor(props.enabled)
 * ```
 */
export function resolveMaybeAccessor<T>(value: MaybeAccessor<T>): T {
  return isAccessor<T>(value) ? value() : value;
}

/**
 * Alias for {@link resolveMaybeAccessor}.
 */
export const toValue = resolveMaybeAccessor;

/**
 * Creates a keyed selector helper for efficient equality checks.
 *
 * @param source Source accessor containing the selected value.
 * @param equals Optional comparison function. Defaults to `Object.is`.
 * @returns Function that compares keys to the current source value.
 *
 * @example
 * ```ts
 * const isSelected = createSelector(selectedId)
 * const active = isSelected(row.id)
 * ```
 */
export function createSelector<T>(
  source: Accessor<T>,
  equals: (left: T, right: T) => boolean = Object.is,
): (key: T) => boolean {
  return (key: T): boolean => equals(source(), key);
}

/**
 * Renders the first truthy {@link Match}, else `fallback`.
 *
 * @param props Switch control-flow props.
 * @returns First matched branch or fallback.
 *
 * @example
 * ```tsx
 * <Switch fallback={<p>idle</p>}><Match when={loading()}>loading</Match></Switch>
 * ```
 */
export function Switch(props: SwitchProps): React.ReactNode {
  const children = React.Children.toArray(props.children);

  for (const child of children) {
    if (!React.isValidElement(child) || child.type !== Match) {
      continue;
    }

    const matchProps = child.props as MatchProps<unknown>;
    const value = readMaybeAccessor(matchProps.when);
    if (!value) {
      continue;
    }

    if (typeof matchProps.children === "function") {
      return (matchProps.children as (value: unknown) => React.ReactNode)(value);
    }

    return matchProps.children;
  }

  return props.fallback ?? null;
}
