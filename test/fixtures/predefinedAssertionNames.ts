function assertAny(any: unknown): asserts any { if (!any) throw Error(); }
function assertNumber(number: unknown): asserts number { if (!number) throw Error(); }
function assertBoolean(boolean: unknown): asserts boolean { if (!boolean) throw Error(); }
function assertString(string: unknown): asserts string { if (!string) throw Error(); }
function assertSymbol(symbol: unknown): asserts symbol { if (!symbol) throw Error(); }
function assertUnknown(unknown: unknown): asserts unknown { if (!unknown) throw Error(); }
function assertNever(never: unknown): asserts never { if (!never) throw Error(); }
function assertUnique(unique: unknown): asserts unique { if (!unique) throw Error(); }
function assertObject(object: unknown): asserts object { if (!object) throw Error(); }
type Assertion = (string: unknown) => asserts string;
interface Validator { check(object: unknown): asserts object; }
class ObjectValidator {
  check(object: unknown): asserts object { if (!object) throw Error(); }
  checkSelf(): asserts this { if (!this) throw Error(); }
}
function isString(string: unknown): asserts string is string { if (typeof string !== 'string') throw Error(); }
function isUnique(unique: unknown): asserts unique is string { if (typeof unique !== 'string') throw Error(); }
function uniqueString(unique: unknown): unique is string { return typeof unique === 'string'; }
function inspect(input: unknown): boolean { assertObject(input); return Boolean(input); }
type Primitives = any | number | boolean | string | symbol | unknown | never | object;
const words = 'asserts string and asserts unknown';
// asserts number remains comment text.
