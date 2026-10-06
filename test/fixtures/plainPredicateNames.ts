declare function isUndefined(undefined: unknown): undefined is string;
function isKeyof(keyof: unknown): keyof is string { return typeof keyof === 'string'; }
declare function isInfer(infer: unknown): infer is string;
type Guard = (value: unknown) => value is string;
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
