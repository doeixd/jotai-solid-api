import * as React from "react";
import { describe, expectTypeOf, it } from "vitest";
import { component, defineComponent, type Accessor, type SolidComponent } from "../src/index";

describe("component typing", () => {
  it("infers no-props components", () => {
    const NoProps = component(() => <div />);

    expectTypeOf(NoProps).toEqualTypeOf<SolidComponent<Record<string, never>>>();
  });

  it("supports strongly typed props accessors", () => {
    type Props = { id: string; count?: number };

    const WithProps = component<Props>((props) => {
      expectTypeOf(props).toEqualTypeOf<Accessor<Readonly<Props>>>();
      return () => (
        <div>
          {props().id}:{props().count ?? 0}
        </div>
      );
    });

    expectTypeOf(WithProps).toEqualTypeOf<SolidComponent<Props>>();
  });

  it("supports defineComponent alias", () => {
    const View = defineComponent(() => {
      return () => <span>ok</span>;
    });

    expectTypeOf(View).toEqualTypeOf<React.ComponentType<Record<string, never>>>();
  });
});
