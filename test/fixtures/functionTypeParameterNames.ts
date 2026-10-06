type UnknownCallback = (unknown: unknown) => unknown;
type NeverCallback = (never: never) => never;
type UniqueCallback = (unique: unknown) => unknown;
type OptionalCallback = (unknown?: number, never?: string) => string;
type GenericCallback = <T>(unknown: T, never?: T) => T;
type Factory = new (unknown: unknown, never?: string) => object;
interface Callable {
  (unknown: unknown): unknown;
  new (never: never): object;
  method(unknown: unknown, never?: string): unknown;
}
declare const callback: UnknownCallback;
declare const factory: Factory;
const value: unknown = callback({ never: 'ordinary property', unknown: 'ordinary property' });
const instance: object = new factory(value);
const optional: OptionalCallback = (unknown, never) => `${unknown}${never}`;
const generic: GenericCallback = <T>(unknown: T) => unknown;
