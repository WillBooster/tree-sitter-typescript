declare function isUndefined(undefined: unknown): undefined is string;
function isKeyof(keyof: unknown): keyof is string { return typeof keyof === 'string'; }
declare function isInfer(infer: unknown): infer is string;
type Guard = (value: unknown) => value is string;
type InferStringGuard = (infer: unknown) => infer is string;
type InferArrayGuard = (infer: unknown) => infer is string[];
type InferUnionGuard = (infer: unknown) => infer is number | string;
interface Guards { isReadonly(readonly: unknown): readonly is string; }
class AbstractGuard { isString(abstract: unknown): abstract is string { return typeof abstract === 'string'; } }
declare function isAsserts(asserts: unknown): asserts is string;
const maybe: unknown = 'value';
if (isUndefined(maybe)) { const text: string = maybe; text.toUpperCase(); }
type Keys = keyof { x: string };
type Inferred<T> = T extends Promise<infer Value> ? Value : never;
type ReadonlyValues = readonly string[];
declare abstract class Base { abstract read(): undefined; }
type is = { x: string };
type Constrained<T> = T extends infer Value extends is ? Value : never;
namespace Qualified {
  export namespace is {
    export type NS = string;
    export type Obj = { x: string };
    export namespace x { export type NS = string; }
  }
  export import Scope = is;
  export type Alias = Scope.NS;
  export let value: is.NS;
  export type Value = is.NS | number;
  export type MaybeValue = Partial<is.NS>;
  export function identity<T extends is.NS>(value: T) { return value; }
  export function matches(value: unknown): value is is.NS { return typeof value === 'string'; }
  export declare const property: { [K in keyof is.Obj]: number };
  export let nested: is.x.NS;
  export let deeper: Qualified.is.NS;
  export let repeated: Qualified.is.x.NS;
  declare function assertKeyof(keyof: unknown): asserts keyof;
  declare function assertInfer(infer: unknown): asserts infer;
  declare function assertReadonly(readonly: unknown): asserts readonly;
  declare function assertAbstract(abstract: unknown): asserts abstract;
  declare function assertAsserts(asserts: unknown): asserts asserts;
  declare function assertUndefined(undefined: unknown): asserts undefined;
  export function stringify(value: unknown) {
    assertKeyof(value); assertInfer(value); assertReadonly(value);
    assertAbstract(value); assertAsserts(value); assertUndefined(value);
    return value.toString();
  }
  export function uppercase(value: unknown) {
    if (matches(value)) return identity(value).toUpperCase();
    return stringify(value);
  }
}

type RequiredTuple = [is: string];
type OptionalTuple = [is?: string];
type RestTuple = [...is: string[]];
type TupleGuard = (is: unknown) => [is: string];
const tupleGuard: TupleGuard = (value) => [String(value)];
const tuple: RequiredTuple = tupleGuard('value');
function readTuple(value: RequiredTuple) { return value[0].toUpperCase(); }
const tupleText = readTuple(tuple);
