import { Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import ts from 'typescript-reference';
import { expect, test } from 'vitest';

import { loadCurrentWasmBuild } from './wasmBuild.js';

type Ranges = [string, number, number][];
const Sources = [
  'const result = value as ? | const.Member;',
  'const result = value as ?A | infer U[Key];',
  'const result = value as ?A | infer U[];',
  'const result = value as ?A & infer U[Key];',
  'const result = value as ?A | keyof B[Key];',
  'const result = value as A extends B ? A | (new () => B) : C;',
  'const result = value as A extends B ? keyof new.Member : C;',
  'const result = value as const.Member & !A;',
  'const result = value as const.Member[!true];',
  'const result = value as !infer.Member<Arg>[];',
  String.raw`const result = value as !\u{10400};`,
  String.raw`const result = value as !A\u0301;`,
  String.raw`const result = value as !A\u200c;`,
  'const result = value as !𐐀;',
  String.raw`const result = value as !Namespace.\u{10400}[];`,
  String.raw`const result = value as const.\u0063lass[];`,
  String.raw`const result = value as typeof Namespace.\u0063lass;`,
  String.raw`const result = value as typeof Namespace.\u0069mport;`,
  String.raw`const result = value as typeof \u0063lass.Member<Arg>;`,
  'const result = value as typeof import("module");',
  String.raw`const result = value as typeof import("module").\u{10400};`,
  'const result = value as typeof Namespace.value as const.Member;',
  'const result = value as typeof Namespace.value satisfies A;',
  'const result = value as typeof Namespace.value instanceof C;',
  'const result = value as typeof Namespace.value\nnew C();',
  'const result = value as keyof new.Member;',
  'const result = value as (x) => const.Member;',
  String.raw`const result = value as (\u0078) => const.Member;`,
  String.raw`const result = value as (\u0074his) => const.Member;`,
  'const result = value as (public [x]: T) => const.Member;',
  'const result = value as (override []) => const.Member;',
  'const result = value as (readonly []);',
  'const result = value as readonly [A][];',
  'const result = value as readonly [keyof I, (a: unknown, b: unknown) => boolean][];',
  'const result = value as readonly [A][Key];',
  'const result = value as readonly [A]!;',
  'const result = value as (readonly []) => const.Member;',
  'const result = value as -1!;',
  'const result = value as const.Member | !true;',
  'const result = value as const.Member | !A[Key];',
  'const result = value as !const.Member[];',
  'const result = value as !!const.Member!;',
  'const result = value as infer U extends !this is A extends B ? C : D;',
  'const result = value as infer U extends !asserts x is A extends B ? C : D;',
  'const result = value as const.Member | !?infer U[];',
  'const result = value as const.Member | !asserts x is infer U[Key];',
  'const result = value as !this is infer U!;',
  'const result = value as !!?keyof infer U[];',
  'const result = value as !{ value: -1 };',
  'const result = value as ![-1n];',
  'const result = value as !Box<-1>;',
  'const result = value as const.Member /* gap */ !;',
  'const result = value as (const /* gap */ !);',
  'const result = value as infer U extends ? | A ? C : D;',
  'const result = value as A extends ? | const.Member ? C : D;',
  'const result = value as const[];',
  'const result = value as const!;',
  'const result = value as const | A;',
  'const result = value as const[number];',
  'const result = value as keyof const;',
  'const result = value as (const)[];',
  'const result = value as const;',
  String.raw`const result = value as \u0063onst.Member[];`,
  String.raw`const result = value as \u0063onst;`,
  'const result = (value as () => asserts x is () => infer U[])++;',
  'const result = (value as new () => asserts x is infer U extends A | infer V[Key])++;',
  'const result = value as () => this is infer U[Key];',
  'const result = value as A extends () => this is infer U ? C : D;',
  'const result = value as A extends () => this is infer U\n? const.Member : D;',
  'const result = value as asserts is;',
  'const result = value as const.Member[asserts is];',
  'const result = value as A extends keyof infer is ? const.Member : D;',

  'const result = (value as () => asserts x is ([A]) | infer U[])++;',
  'const result = value as () => asserts x is A | infer U[Key];',
  'const result = value as new () => asserts x[Key];',
  'const result = value as new () => asserts is [A];',
  'const result = value as new () => x is const.Member;',
  'const result = value as new () => asserts x is const.Member;',
  'const result = (value as const.Member[])\n(b);',
  'const result = (value as A!)\n[0];',

  'const result = value as () => asserts x[K];',
  'const result = value as () => asserts x | const.M;',
  'const result = value as () => asserts x[] & const.M;',
  'const result = value as () => asserts this[Key];',
  'const result = value as A extends (() => asserts x[Key]) ? C : const.M;',
  String.raw`const result = value as keyof infer \u0078;`,
  String.raw`const result = value as keyof infer \u03c0;`,

  'const result = value as const.Member[- /* gap */ .1];',
  'const result = value as () => any.Member[.1];',
  'const result = value as A extends const.Member[-\n1n] ? B : C;',
  'const result = value as A extends string[] ? D : const.Member;',
  'const result = value as A extends string[Key] ? D : const.Member;',
  'const result = value as A extends readonly string[] ? D : const.Member;',
  'const result = value as A extends number[] ? C : D | const.Member;',
  'const result = value as () => any.Member[any.Key];',
  'const result = value as new () => any.Member[(number.Key)];',
  'const result = value as () => x is A.Member[K & unknown.Key];',
  'const result = value as () => asserts x is const.Member[any.Key];',
  'const result = value as () => A.Member[(const.Key)];',
  'const result = value as const.Member[(const.Key)];',
  'const result = value as const.Member[((/* gap */ const.Key))];',
  'const result = value as const.Member[(in.Key)];',
  'const result = value as const.Member[(...args: A[]) => B];',
  String.raw`const result = value as const.Member[(\u0074his: A) => B];`,
  'const result = value as (class.Key);',
  'const result = value as () => unknown.Member[typeof Namespace.value];',
  'const result = value as () => any.Member;',
  'const result = value as new () => unknown.Member<Arg>;',
  'const result = value as () => x is string.Member[Key];',
  'const result = value as () => asserts x is number.Member[];',
  'const result = value as keyof const extends A ? B : () => symbol.Member;',
  'const result = value as () => A | any.Member;',
  'const result = value as () => never.Member.Nested<Arg>!;',
  'const result = value as ?unique symbol.Member;',
  'const result = value as unique !symbol;',
  'const result = value as unique !symbol[];',
  'const result = value as unique !(symbol[]);',
  'const result = value as A extends unique infer U ? const : D;',
  'const result = value as A extends unique infer U ?\nconst.Member : D;',
  'const result = value as infer U | unique symbol\n.Member;',
  'const result = value as ?keyof unknown.Member;',
  'const result = value as ?unique string.Member<Arg>[Key];',
  'const result = value as A extends keyof number.Member ? B : const.Member;',
  'const result = value as () => readonly is [A];',
  'const result = value as () => this is const.Member;',
  'const result = value as () => asserts is const.Member;',
  'const result = value as () => /* before */ x /* between */ is const.Member;',
  'const result = value as () => asserts x /*\n*/is const.Member;',
  String.raw`const result = value as () => \u0078 is const.Member;`,
  String.raw`const result = value as () => asserts \u0078 is const.Member;`,
  'const result = value as keyof const extends A ? B : () => const.Member;',
  'const result = value as keyof const extends A ? B : (x: A) => const.Member[Key];',
  'const result = value as keyof const extends A ? B : <T>() => const.Member<T>;',
  'const result = value as keyof const extends A ? B : new () => const.Member;',
  'const result = value as keyof const extends A ? B : abstract new () => const.Member[];',
  'const result = value as keyof const extends A ? B : () => x is const.Member;',
  'const result = value as keyof const extends A ? B : () => asserts x is const.Member;',
  'const result = value as () => const.Member;',
  'const result = value as () => A | const.Member;',
  'const result = value as A extends () => infer U ? const : D;',
  'const result = value as A extends new () => infer U ? const.Member : D;',
  'const result = value as A extends () => x is infer U ? const.Member : D;',
  'const result = value as A extends () => infer U extends infer V ? const.Member : infer W ? const : D;',
  'const result = value as A extends () => readonly infer U ? const.Member : D;',
  'const result = value as A extends () => B | infer U ? const.Member : D;',
  'const result = value as const.Member extends | readonly infer U extends () => B ? C : D;',
  'const result = value as const.Member extends | readonly (() => B) ? C : D;',
  'const result = value as A extends B /*\n*/? const.Member : D;',
  'const result = value as A extends infer U /*\n*/? const : D;',
  'const result = value as A extends infer U ? const.Member : D;',
  'const result = value as (A extends infer U ? const.Member : D);',
  'const result = value as A extends keyof infer U ? const.Member : D;',
  'const result = value as A extends readonly infer U ? const.Member : D;',
  'const result = value as A extends B | infer U ? const.Member : D;',
  'const result = value as A extends B & infer U ? const.Member : D;',
  'const result = value as A extends infer U extends infer V ? const.Member : D;',
  'const result = value as A extends infer any ? const.Member : D;',
  'const result = value as A extends B\n? const.Member : D;',
  'const result = value as (A extends B\n? const : D);',
  'const result = value as A extends | B ? C : const.Member;',
  'const result = value as A extends & B ? C : const.Member;',
  'const result = value as A extends | infer U ? const.Member : D;',
  'const result = value as A extends & infer U ? const.Member : D;',
  'const result = value as ((typeof import("module")));',
  'const result = value as (typeof import("module").Member<Arg>);',
  'const result = value as (typeof import("module").Member<Arg>)[];',
  'const result = value as (typeof Namespace.value);',
  'const result = value as ((typeof Namespace.value));',
  'const result = value as readonly (keyof typeof Namespace.value)[];',
  'const result = value as (typeof Namespace.value)!;',
  'const result = value as (A extends infer U ? const : D);',
  'const result = value as A extends B ? typeof Namespace.value : C;',
  'class C { field = value as A<Arg>!; next = 1; }',
  'const result = value as const.Member | typeof operand << 1;',
  'const result = value as ?typeof Namespace.value< <T>() => T> << 1;',
  'const result = value as const.Member | typeof import("module")<<T>() => T>;',
  'const result = value as const.Member | typeof import("module").value<<T>() => T>;',
  'const result = value as const.Member | typeof this<Arg>;',
  'const result = value as ?typeof operand<Arg>;',
  'const result = value as ?typeof operand<Arg>[];',
  'const result = value as ??typeof Namespace.value<Arg>;',
  'const result = value as ?typeof Namespace.value<Arg>[Key];',
  'const result = value as ?A | typeof Namespace.value<Arg>;',
  'const result = value as const.Member | typeof Namespace.value<Arg>;',
  'const result = value as const.Member & typeof operand<Arg> ? left : right;',
  'const result = value as infer U extends typeof Namespace.value<Arg>;',
  'const result = value as const.Member | typeof import("module");',
  'const result = value as const.Member | typeof import("module").value<Arg>;',
  'const result = value as const.Member | typeof import("module")<Arg>;',
  'const result = value as const.Member | import("module").Type<Arg>;',
  'const result = value as const.Member | typeof operand <= other;',
  'const result = value as const.Member | typeof operand\n< other;',
  'const result = value as const.class;',
  'const result = value as | const.Member;',
  'const result = value as | const.Member & Other;',
  'const result = value as | const.Member & Other | Last;',
  'const result = value as | const.Member & Other extends Base ? Left : Right;',
  'const result = value as & const.Member;',
  'const result = value as | A | const.Member;',
  'const result = value as | A & const.Member | const.Other;',
  'const result = value as & A & const.Member;',
  'const result = value as | A!;',
  'const result = value as ? & const.Member!;',
  'const result = value as | infer U extends B;',
  'const result = value as | ?A![] extends B ? C : D;',

  'const result = value as infer U extends infer V extends B;',
  'const result = value as infer U extends infer V\nextends B;',
  'const result = value as infer U extends B | C ? D : E;',
  'const result = value as infer U extends B[];',
  'const result = value as infer U extends B[Key];',
  'const result = value as infer U extends Namespace.Member;',
  'const result = value as infer U extends Namespace.Member<Arg>;',
  'const result = value as infer U extends typeof Namespace.value;',
  'const result = value as infer U extends B | Namespace.Member;',
  'const result = value as infer U extends B | A[];',
  'const result = value as infer U extends B[Key] ? C : D;',
  'const result = value as infer U extends const.Member | B;',

  'const result = value as infer U extends B ?? fallback;',
  'const result = value as infer U extends const.Member ?? fallback;',
  'const result = value as A extends ? infer U extends infer V extends B ? C : D ? other : last / 2;',

  'const result = value as A | const.X | const.Y;',
  'const result = value as A | const.X<T> & const.Y[Key] | const.Z[];',
  'const result = value as A & const.X & const.Y;',
  'const result = value as ?A![];',
  'const result = value as ?A[]!;',
  'const result = value as ??A![];',
  'const result = value as ?const.Member![];',
  'const result = value as ?A | const.Member![];',
  'const result = value as keyof ?const.Member![];',
  'const result = value as ?keyof A![];',
  'const result = value as A extends readonly infer U extends const ? C : D;',
  'const result = value as A extends keyof infer U extends B ? C : D ? other : last / 2;',
  'const result = value as A extends keyof readonly infer U extends const ? C : D;',
  'const result = value as A extends readonly keyof infer U extends B ? C : D ? other : last / 2;',
  'const result = value as A extends unique infer U extends const ? C : D;',

  'const result = value as const /* namespace */ . Member;',
  'const result = value as const\n.Member;',
  'const result = value as const.Member.Nested;',
  'const result = value as const.Member<Arg>;',
  'const result = value as const.Member.Nested<Arg>;',
  'const result = value as const.Member[];',
  'const result = value as const.Member[Key];',
  'const result = value as const.Member<Arg>[Key][];',
  'const result = value as const.Member<typeof Namespace.value>;',
  'const result = value as const.Member[typeof Namespace.value];',
  'const result = value as const.Member[] | Other;',
  'const result = value as const.Member[Key] & Other | Third;',
  'const result = value as const.Member extends Base ? Left : Right;',
  'const result = value as const.Member[Key] extends Base ? Left : Right;',
  'const result = value as const.Member <= other;',
  'const result = (value as const.Member) << other;',
  'const result = value as const.Member\n[Key];',
  'const result = value as const.Member /* gap */ [Key];',
  'const result = value as Namespace.const.Member;',
  'const result = value as Namespace.Member.const;',
  'const result = value as const.Member!;',
  'const result = value as const.Member[]!;',
  'const result = value as const.Member | A[];',
  'const result = value as const.Member | A & B;',
  'const result = value as const.Member extends A ? B : C[];',
  'const result = value as const.Member | const.Other;',
  'const result = value as const.Member & const.Other;',
  'const result = value as const.Member extends const.Other ? A : B;',
  'const result = value as const.Member extends A ? B : const.Other;',
  'const result = value as A | const.Other;',
  'const result = (value as const.Member[])();',
  'const result = (value as const.Member[])?.field;',
  'const result = (value as const.Member[])++;',
  'const result = value as const.Member[Key] < other;',
  'const result = value as const.Member[Key][Other] << other;',
  'const result = value as const.Member<Arg> << other;',
  'const result = value as const.Member<Arg>[] < other;',
  'const result = value as const.Member | A!;',
  'const result = value as const.Member![];',
  'const result = value as const.Member extends A ? (const.Other) : const.Third;',
  'const result = value as A extends B ? (const.Other) : C;',
  'const result = value as const.Member extends A ? B | const.Other : C;',
  'const result = value as const.Member != other;',
  'const result = value as const.Member !== other;',
  'const result = value as const.Member! == other;',
  'const result = value as keyof A!;',
  'const result = value as keyof A[]!;',
  'const result = value as unique symbol!;',
  'const result = value as unique symbol[];',
  'const result = value as unique symbol[Key];',
  'const result = value as unique readonly A[];',
  'const result = value as unique keyof A;',
  'const result = value as keyof const.Member!;',
  'const result = value as keyof keyof A!;',
  'const result = value as readonly A[]!;',
  'const result = value as A.B extends B ? C : const.D;',
  'const result = value as const.Member ?.5 : 1;',
  'const result = value as const.Member[Key] ?.5 : 1;',
  'const result = value as A | const.Member<Arg> ?.5 : 1;',
  'const result = value as const.Member extends (B extends C ? D : E) ? F : G;',
  'const result = value as const.Member extends Box<B extends C ? D : E> ? F : G;',
  'const result = value as const.Member extends B | C & D ? F : G;',
  'const result = value as const.Member extends unique symbol ? E : F;',
  'const result = value as const.Member extends unique symbol! ? E : F;',
  'const result = value as X extends Y ? Z : const.Member<Arg> / 2;',
  'const result = value as X extends Y ? Z : const.Member.Nested<Arg> /2/ other;',
  'const result = value as X extends Y ? Z : const.Member<Arg>\n[0];',
  'const result = value as X extends Y ? Z : const.Member<Arg>\n(other);',
  'const result = value as X extends Y ? Z : const.Member<Arg>\n++other;',
  'const result = value as X extends Y ? Z : const.Member<Arg>\n`text`;',
  'const result = value as X extends Y ? Z : const.Member<Arg>\n!other;',
  'const result = value as X extends Y ? Z : A | const.Member<Arg> / 2;',
  'const result = value as X extends Y ? Z : A & const.Member<Arg> / 2;',
  'const result = value as X extends Y ? Z : const.Member[Key]<Arg>(other);',
  'const result = value as X extends Y ? Z : const.Member!<Arg>(other);',
  'const result = value as const.Left extends Y ? Z : const.Member[Key]<Arg>(other);',
  'const result = value as X extends Y ? Z : A | const.Member[Key]<Arg>(other);',
  'const result = value as X extends Y ? Z : const.Member[Key]<A<B> | C<D> | E<F>>(other);',
  'const result = value as A extends infer T extends const ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends const.Member ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends infer U extends const ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends B ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends (B extends C ? D : E) ? F : G ? other : last / 2;',
  'const result = value as A extends infer T extends Box<B extends C ? D : E> ? F : G ? other : last / 2;',
  'const result = value as A extends infer T extends () => B extends C ? D : E ? F : G ? other : last / 2;',
  'const result = value as A extends infer T extends keyof B ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends readonly B[] ? C : D ? other : last / 2;',
  'const result = value as A extends infer T extends B | C ? D : E ? other : last / 2;',
  'const result = value as A extends infer T extends infer U extends B ? C : D ? other : last / 2;',
  'const result = value as typeof Namespace.value<Arg>;',
  'const result = value as typeof Namespace.value<Arg> / 2;',
  'const result = value as A[Key]\n(other);',
  'const result = value as A | B\n(other);',
  'const result = value as const /* gap */;',
  'const result = value as const / 2;',
  'const result = value as const <= other;',
  'const result = value as const!;',
  'const result = value as const[]!;',
  'const result = value as const[Key]!;',
  'const result = value as const![];',
  'const result = value as const![Key];',
  'const result = value as const!!;',
  'const result = value as (const)!;',
  'const result = value as keyof const[]!;',

  'const result = value as const;',
  'const result = (value as const).class;',
  'const result = value as const[Key];',
  'const result = value as const<Arg>;',
  'const result = value as const.Member + other;',
  'const result = value as const.Member as Other;',
];
const InvalidContexts = [
  'const invalid = value as A extends B ? A | new.Member : C;',
  'const invalid = value as A extends B ? C : A | new.Member;',
  'const invalid = value as A extends B | new.Member ? C : D;',
  'const invalid = value as A extends B ? A & new.Member : C;',
  String.raw`const invalid = value as typeof \u0069mport;`,
  String.raw`const invalid = value as typeof \u0069mport` + '\n<2;',
  String.raw`const invalid = value as typeof \u0069mport.Member` + '/*\n*/<2;',
  'const invalid = value as A extends B ? infer : D;',
  String.raw`const invalid = value as !\u007f;`,
  String.raw`const invalid = value as !\u{1f600};`,
  String.raw`const invalid = value as !\u0301;`,
  String.raw`const invalid = value as !\uD800;`,
  'const invalid = value as !A\u2060;',
  String.raw`const invalid = value as !Namespace.\u007f;`,
  String.raw`const invalid = value as const.\u007f[];`,
  String.raw`const invalid = value as !const.\u0301;`,
  String.raw`const invalid = value as !typeof Namespace.\u{1f600};`,
  String.raw`const invalid = value as typeof import("module").\u007f;`,
  'const invalid = value as typeof Namespace.value extra;',
  'const invalid = value as typeof Namespace.value new C();',
  'const invalid = value as A extends B ? C : infer.Member;',
  'const invalid = value as A extends B ? (infer) : D;',
  'const invalid = value as ?readonly | A;',
  'const invalid = value as unique function.Member;',
  'const invalid = value as function.Member!;',
  String.raw`const invalid = value as !\u0074ypeof;`,
  String.raw`const invalid = value as !\u0061ny[];`,
  String.raw`const invalid = value as A extends B ? C : \u006eull!;`,
  String.raw`const invalid = value as \u0069nfer U;`,
  'const invalid = value as +1!;',
  'const invalid = value as const.Member | +1[];',
  'const invalid = value as () => +1!;',
  'const invalid = value as A extends +1! ? B : const.Member;',
  'const invalid = value as !{ value: +1 };',
  'const invalid = value as ![+1n];',
  'const invalid = value as !Box<+1>;',
  'const invalid = value as (const /*\n*/ !);',
  'const invalid = value as A extends const /*\n*/ ! ? C : D;',
  'const invalid = value as A extends B ? Name /*\n*/ ! : D;',
  String.raw`const invalid = value as A extends B ? \u0063onst! : D;`,
  'const invalid = value as A extends () => asserts x is infer U extends infer V ? const.Member : infer W ? const.Member : D;',
  'const invalid = value as A extends () => this is infer U ? const.Member : D;',
  'const invalid = value as new () => asserts is;',
  'const invalid = (value as A!\n(1));',
  'const invalid = (value as A!\n[0]);',
  'const invalid = (value as const.Member[]\n(1));',
  'const invalid = (value as const.Member[]\n[0]);',
  'const invalid = (value as (const.Member)\n(1));',
  'const invalid = (value as (const.Member)\n[0]);',
  'const invalid = (value as readonly const.Member[]\n[0]);',

  String.raw`const invalid = value as keyof infer \u0063onst;`,
  String.raw`const invalid = value as A extends infer \u{63}lass ? const.M : D;`,
  String.raw`const invalid = value as infer \u0074his;`,
  String.raw`const invalid = value as () => \u0063onst is const.M;`,
  String.raw`const invalid = value as () => asserts \u0065num is const.M;`,

  'const invalid = value as () => any.Member[class.Key];',
  'const invalid = value as const.Member[(class.Key)];',
  'const invalid = value as () => A[(/* gap */ (class.Key))];',
  String.raw`const invalid = value as A[(\u0063lass.Key)];`,
  'const invalid = value as A extends any.Member[+1] ? C : const.Last;',
  String.raw`const invalid = value as A extends any.Member[\u0063onst.Key] ? C : const.Last;`,
  'const invalid = value as () => A.Member[const.Key];',
  'const invalid = value as const.Member[const.Key];',
  'const invalid = value as () => any.Member[void.Key];',
  'const invalid = value as const.Member[(const.Key)()];',
  'const invalid = value as () => void.Member;',
  'const invalid = value as ?unique void.Member;',
  'const invalid = value as const.Member extends A ? B : () => void.Member;',
  'const invalid = value as () => any.Member<Arg>();',
  'const invalid = value as const.Member | number.Member<Arg>();',
  'const invalid = value as () => x /*\n*/is const.Member;',
  'const invalid = value as () => void is const.Member;',
  'const invalid = value as () => enum is const.Member;',
  'const invalid = value as () => asserts void is const.Member;',
  'const invalid = value as () => asserts enum is const.Member;',
  'const invalid = value as A extends infer enum ? const.Member : D;',
  String.raw`const invalid = value as () => x \u0069s const.Member;`,
  'const invalid = value as () => const.Member();',
  'const invalid = value as const.Member | () => B;',
  'const invalid = value as A extends () => infer U extends infer V ? const.Member : D;',
  'const invalid = value as A extends () => asserts x is infer U ? const.Member : D;',
  'const invalid = value as const.Member extends | readonly () => B ? C : D;',
  'const invalid = value as const.Member extends | keyof () => B ? C : D;',
  'const invalid = value as const.Member extends | unique () => B ? C : D;',
  'const invalid = value as ((typeof import("module")))();',
  'const invalid = value as (typeof import("module").Member<Arg>)?.field;',
  'const invalid = value as ((typeof import("module").Member<Arg>))++;',
  'const invalid = value as A extends infer U extends B ? const.Member : D;',
  'const invalid = value as A extends (infer U) ? const.Member : D;',
  'const invalid = value as A extends infer U | B ? const.Member : D;',
  'const invalid = value as A extends infer const ? const.Member : D;',
  'const invalid = value as A extends infer class ? const.Member : D;',
  'const invalid = value as A extends infer void ? const.Member : D;',
  'const invalid = value as const.Member extends | () => B ? C : D;',
  'const invalid = value as const.Member extends | new () => B ? C : D;',
  'const invalid = value as const.Member extends B | () => C ? D : E;',
  'const invalid = value as const.Member | typeof operand<<T>() => T>;',
  'const invalid = value as (const.Member) | typeof Namespace.value();',
  'const invalid = value as const.Member & typeof Namespace.value?.property;',
  'const invalid = value as ?A | typeof Namespace.value?.();',
  'const invalid = value as ?A | typeof operand < other;',
  'const invalid = value as A! | typeof operand < other;',

  'const invalid = value as | const.Member();',
  'const invalid = value as & const.Member?.();',
  'const invalid = value as A | const.X | const.Y();',
  'const invalid = value as A & const.X & const.Y();',
  'const invalid = value as A | const.X | const.Y?.();',
  'const invalid = value as A | const.X | const.Y[]();',
  'const invalid = value as X extends const.Right ? Z : const.Member<Arg>(other);',
  'const invalid = value as X extends const[]! ? Y : Z<Arg>(other);',
  'type Result = Box<const.Member>;',
  'type Result = [const.Member];',
  'type Result = T extends X ? const.Member : Y;',
  'class Result implements const.Member {}',
  'const invalid = value as const.Member[].field;',
  'const invalid = value as const.Member < other;',
  'const invalid = value as const.Member << other;',
  'const invalid = value as const.Member\nextends A ? B : C;',
  'const invalid = value as const.Member[]\nextends A ? B : C;',
  'const invalid = value as const.Member[]();',
  'const invalid = value as const.Member[]?.field;',
  'const invalid = value as const.Member[]++;',
  'const invalid = value as const.Member!();',
  'const invalid = value as const.Member!?.field;',
  'const invalid = value as const.Member extends B extends C ? D : E ? F : G;',
  'const invalid = value as const.Member[] extends B | C extends D ? E : F ? G : H;',
  'const invalid = value as const.Member[Key] extends B & C extends D ? E : F ? G : H;',
];
const SyntaxControls = ['const result = value as unknown.field;', 'const result = value as any.field;'];
const Following = '\nconst following = 1;';

for (const dialect of ['typescript', 'tsx']) {
  test(`preserves ${dialect} qualified const type ranges`, async () => {
    await Parser.init();
    const language = await loadCurrentWasmBuild(dialect);
    const parser = new Parser();
    let query: Query | undefined;
    try {
      parser.setLanguage(language);
      query = new Query(
        language,
        '(function_type) @functionType (constructor_type) @constructorType (function_type return_type: (_) @functionReturn) (constructor_type type: (_) @constructorReturn) (type_predicate) @predicate (type_predicate type: (_) @predicateType) (asserts) @asserts (comment) @comment (nested_type_identifier) @qualified (generic_type) @generic (as_expression) @as (satisfies_expression) @satisfies ' +
          '(required_parameter pattern: (pattern/array_pattern) @arrayBinding) (jsdoc_unknown_type) @unknownType ((type_identifier) @constType (#eq? @constType "const")) (as_expression "const" @wholeConst) ' +
          '(flow_maybe_type) @flowMaybe (flow_maybe_type (type) @flowMaybeOperand) (readonly_type) @readonlyOperator (readonly_type (type) @readonlyOperand) (infer_type) @infer (array_type) @array (lookup_type) @lookup (union_type) @union (intersection_type) @intersection (conditional_type) @conditional ' +
          '(unique_type) @uniqueOperator (unique_type "unique" @uniqueKeyword type: (type) @uniqueOperand) (predefined_type "unique symbol") @uniqueSymbol (index_type_query) @keyof (type_query) @typeQuery (type_query (member_expression) @queryOperand) (non_nullable_type) @nonNullable (non_nullable_type (primary_type) @nullableOperand)' +
          ' (index_type_query (infer_type) @inferOperand) (readonly_type (infer_type) @inferOperand) (unique_type (infer_type) @inferOperand) (type_query [(identifier) (this)] @queryOperand) (type_query (instantiation_expression [(identifier) (this)] @queryOperand)) (type_query (instantiation_expression (member_expression) @queryOperand)) (as_expression (type) @assertedType) (array_type (primary_type) @arrayOperand)' +
          ' (lookup_type (primary_type) @lookupOperand "[") (conditional_type left: (type) @conditionalLeft) (binary_expression operator: _ @binaryOperator) @binary (ternary_expression) @ternary' +
          (dialect === 'typescript' ? ' (type_assertion) @angle' : '')
      );
      const sources = [
        ...Sources,
        ...SyntaxControls,
        ...(dialect === 'typescript' ? ['const result = <const>value;'] : []),
      ].map((source) => source + Following);
      const syntaxSources = new Set(SyntaxControls.map((source) => source + Following));
      const invalidSources = InvalidContexts.map((source) => source + '\n' + Sources[0] + Following);
      for (const source of [...sources, ...invalidSources]) {
        const tree = parser.parse(source)!;
        try {
          checkRanges(tree, source, dialect, query, !invalidSources.includes(source), !syntaxSources.has(source));
        } finally {
          tree.delete();
        }
      }
    } finally {
      query?.delete();
      parser.delete();
    }
  });
}

function checkRanges(
  tree: Tree,
  source: string,
  dialect: string,
  query: Query,
  valid = true,
  compareRanges = true
): void {
  const fileName = dialect === 'tsx' ? 'const.tsx' : 'const.ts';
  const reference = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? reference : undefined);
  const program = ts.createProgram([fileName], options, host);
  expect(program.getSyntacticDiagnostics(reference).length === 0, source).toBe(valid);
  expect(tree.rootNode.hasError, source).toBe(!valid);
  expect(tree.rootNode.lastNamedChild!.text).toBe('const following = 1;');
  if (!valid || !compareRanges) return;
  const expected: Record<string, Ranges> = {
    functionType: [],
    constructorType: [],
    functionReturn: [],
    constructorReturn: [],
    predicate: [],
    predicateType: [],
    asserts: [],
    unknownType: [],
    arrayBinding: [],
    constType: [],
    wholeConst: [],
    comment: [],
    flowMaybe: [],
    flowMaybeOperand: [],
    readonlyOperator: [],
    readonlyOperand: [],
    infer: [],
    inferOperand: [],
    ternary: [],
    binary: [],
    binaryOperator: [],
    keyof: [],
    uniqueOperator: [],
    uniqueKeyword: [],
    uniqueOperand: [],
    uniqueSymbol: [],
    qualified: [],
    generic: [],
    as: [],
    satisfies: [],
    angle: [],
    array: [],
    lookup: [],
    union: [],
    intersection: [],
    conditional: [],
    typeQuery: [],
    queryOperand: [],
    assertedType: [],
    arrayOperand: [],
    lookupOperand: [],
    conditionalLeft: [],
    nonNullable: [],
    nullableOperand: [],
  };
  const collect = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isArrayBindingPattern(node.name))
      expected.arrayBinding!.push([node.name.getText(reference), node.name.getStart(reference), node.name.end]);
    if (node.kind === ts.SyntaxKind.JSDocUnknownType)
      expected.unknownType!.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
      if (
        name.getText(reference) === 'const' &&
        !(
          (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)) &&
          node.parent.type === node &&
          node.getText(reference) === 'const'
        )
      )
        expected.constType!.push([name.getText(reference), name.getStart(reference), name.end]);
    }
    if (ts.isFunctionTypeNode(node)) {
      expected.functionType!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.functionReturn!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    }
    if (ts.isConstructorTypeNode(node)) {
      expected.constructorType!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.constructorReturn!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    }
    if (ts.isTypePredicateNode(node)) {
      if (node.assertsModifier) expected.asserts!.push([node.getText(reference), node.getStart(reference), node.end]);
      if (!node.assertsModifier || node.type) {
        const start = node.parameterName.getStart(reference);
        expected.predicate!.push([source.slice(start, node.end), start, node.end]);
      }
      if (node.type)
        expected.predicateType!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    }
    if (ts.isJSDocNullableType(node) && !node.postfix) {
      expected.flowMaybe!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.flowMaybeOperand!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    }
    if (ts.isInferTypeNode(node)) expected.infer!.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      expected.readonlyOperator!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.readonlyOperand!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    }
    if (ts.isTypeOperatorNode(node) && ts.isInferTypeNode(node.type))
      expected.inferOperand!.push([node.type.getText(reference), node.type.getStart(reference), node.type.end]);
    if (ts.isConditionalExpression(node))
      expected.ternary!.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isBinaryExpression(node)) {
      expected.binary!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.binaryOperator!.push([
        node.operatorToken.getText(reference),
        node.operatorToken.getStart(reference),
        node.operatorToken.end,
      ]);
    }
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword && !uniqueSymbolOperand(node)) {
      expected.uniqueOperator!.push([node.getText(reference), node.getStart(reference), node.end]);
      const keyword = node.getFirstToken(reference)!;
      expected.uniqueKeyword!.push([keyword.getText(reference), keyword.getStart(reference), keyword.end]);
      expected.uniqueOperand!.push(publicTypeRange(node.type, reference));
    }
    if (ts.isTypeOperatorNode(node)) {
      const symbol = uniqueSymbolOperand(node);
      if (symbol)
        expected.uniqueSymbol!.push([
          source.slice(node.getStart(reference), symbol.end),
          node.getStart(reference),
          symbol.end,
        ]);
    }
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword)
      expected.keyof!.push([node.getText(reference), node.getStart(reference), node.end]);
    if (ts.isJSDocNonNullableType(node)) {
      expected.nonNullable!.push(publicTypeRange(node, reference));
      expected.nullableOperand!.push(publicTypeRange(node.type, reference));
    }
    if (ts.isAsExpression(node)) {
      const range: Ranges[number] = [node.type.getText(reference), node.type.getStart(reference), node.type.end];
      expected.assertedType!.push(range);
      if (ts.isTypeReferenceNode(node.type) && node.type.getText(reference) === 'const')
        expected.wholeConst!.push(range);
    }
    const operand = ts.isArrayTypeNode(node)
      ? node.elementType
      : ts.isIndexedAccessTypeNode(node)
        ? node.objectType
        : undefined;
    if (operand)
      expected[ts.isArrayTypeNode(node) ? 'arrayOperand' : 'lookupOperand']!.push(publicTypeRange(operand, reference));
    if (ts.isConditionalTypeNode(node))
      expected.conditionalLeft!.push([
        node.checkType.getText(reference),
        node.checkType.getStart(reference),
        node.checkType.end,
      ]);
    if (ts.isImportTypeNode(node)) {
      if (node.isTypeOf) {
        expected.typeQuery!.push([node.getText(reference), node.getStart(reference), node.end]);
        if (node.qualifier) {
          const start = node
            .getChildren(reference)
            .find((child) => child.kind === ts.SyntaxKind.ImportKeyword)!
            .getStart(reference);
          expected.queryOperand!.push([reference.text.slice(start, node.qualifier.end), start, node.qualifier.end]);
        }
      } else if (node.qualifier && node.typeArguments) {
        expected.generic!.push([node.getText(reference), node.getStart(reference), node.end]);
      }
    }
    if (ts.isTypeQueryNode(node)) {
      expected.typeQuery!.push([node.getText(reference), node.getStart(reference), node.end]);
      expected.queryOperand!.push([
        node.exprName.getText(reference),
        node.exprName.getStart(reference),
        node.exprName.end,
      ]);
    }
    if (ts.isTypeReferenceNode(node) && node.typeArguments) {
      expected.generic!.push([node.getText(reference), node.getStart(reference), node.end]);
    }
    const typeKind = ts.isArrayTypeNode(node)
      ? 'array'
      : ts.isIndexedAccessTypeNode(node)
        ? 'lookup'
        : ts.isUnionTypeNode(node)
          ? 'union'
          : ts.isIntersectionTypeNode(node)
            ? 'intersection'
            : ts.isConditionalTypeNode(node)
              ? 'conditional'
              : undefined;
    if (typeKind) expected[typeKind]!.push(publicTypeRange(node, reference));
    if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
      expected.qualified!.push([
        node.typeName.getText(reference),
        node.typeName.getStart(reference),
        node.typeName.end,
      ]);
    } else if (ts.isExpressionWithTypeArguments(node) && ts.isPropertyAccessExpression(node.expression)) {
      expected.qualified!.push([
        node.expression.getText(reference),
        node.expression.getStart(reference),
        node.expression.end,
      ]);
    }
    const kind = ts.isAsExpression(node)
      ? 'as'
      : ts.isSatisfiesExpression(node)
        ? 'satisfies'
        : ts.isTypeAssertionExpression(node)
          ? 'angle'
          : undefined;
    if (kind) expected[kind]!.push([node.getText(reference), node.getStart(reference), node.end]);
    ts.forEachChild(node, collect);
  };
  collect(reference);
  const comments = new Map<number, Ranges[number]>();
  const collectComments = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ]) {
      comments.set(comment.pos, [source.slice(comment.pos, comment.end), comment.pos, comment.end]);
    }
    for (const child of node.getChildren(reference)) collectComments(child);
  };
  collectComments(reference);
  expected.comment!.push(...comments.values());
  const actual: Record<string, Ranges> = Object.fromEntries(Object.keys(expected).map((name) => [name, []]));
  for (const { name, node } of query.captures(tree.rootNode)) {
    if (
      (name === 'union' && node.parent?.type === 'union_type') ||
      (name === 'intersection' && node.parent?.type === 'intersection_type')
    )
      continue;
    actual[name]!.push([node.text, node.startIndex, node.endIndex]);
  }
  const byRange = (a: Ranges[number], b: Ranges[number]): number => a[1] - b[1] || b[2] - a[2];
  for (const name of Object.keys(expected)) {
    expect(actual[name]!.toSorted(byRange), `${name}: ${source}`).toEqual(expected[name]!.toSorted(byRange));
  }
}

function publicTypeRange(node: ts.Node, reference: ts.SourceFile): Ranges[number] {
  let current = node;
  while (current.parent && postfixTypeOperand(current.parent) === current) current = current.parent;
  const operator = current.parent;
  const start =
    operator && ts.isTypeOperatorNode(operator) && uniqueSymbolOperand(operator)
      ? operator.getStart(reference)
      : node.getStart(reference);
  return [reference.text.slice(start, node.end), start, node.end];
}

function uniqueSymbolOperand(node: ts.TypeOperatorNode): ts.TypeNode | undefined {
  if (node.operator !== ts.SyntaxKind.UniqueKeyword) return undefined;
  let operand = node.type;
  for (let next = postfixTypeOperand(operand); next; next = postfixTypeOperand(operand)) operand = next;
  return operand.kind === ts.SyntaxKind.SymbolKeyword ? operand : undefined;
}

function postfixTypeOperand(node: ts.Node): ts.TypeNode | undefined {
  if (ts.isArrayTypeNode(node)) return node.elementType;
  if (ts.isIndexedAccessTypeNode(node)) return node.objectType;
  return ts.isJSDocNonNullableType(node) && node.postfix ? node.type : undefined;
}
