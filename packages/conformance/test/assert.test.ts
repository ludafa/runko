/**
 * 断言本身的测试。
 *
 * **为什么值得单独测**：这一层是手写的，替掉了 vitest 那套身经百战的匹配器。它一旦
 * 判错，后果不是「某条用例挂了」，而是**整套一致性套件给出错误的绿灯**——一个不合契约
 * 的持久化实现会被判成合格。深比较与部分匹配尤其容易写错（`undefined` 与缺键、数组
 * 长度、嵌套对象），所以逐条钉住。
 */
import { describe, expect, it } from "vitest";

import * as assert from "../src/assert.js";
import { ConformanceAssertionError } from "../src/assert.js";

/** 断言 `fn` 抛的是我们自己那个错误类型。 */
function rejects(fn: () => void): void {
  expect(fn).toThrow(ConformanceAssertionError);
}

describe("same / notSame", () => {
  it("按 Object.is 判", () => {
    assert.same(1, 1);
    assert.same("a", "a");
    assert.same(undefined, undefined);
    assert.same(NaN, NaN); // Object.is 认这个，=== 不认
    rejects(() => assert.same(1, 2));
    rejects(() => assert.same({}, {})); // 引用不同
  });

  it("notSame 是它的反面", () => {
    assert.notSame(1, 2);
    assert.notSame({}, {});
    rejects(() => assert.notSame(1, 1));
  });
});

describe("equal（深比较）", () => {
  it("结构相同即相等，跟引用无关", () => {
    assert.equal({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
    assert.equal([{ x: 1 }], [{ x: 1 }]);
    assert.equal(null, null);
  });

  it("**`undefined` 的键与缺失的键视为相同**——JSON 往返之后就是这个形状", () => {
    assert.equal({ a: 1, b: undefined }, { a: 1 });
    assert.equal({ a: 1 }, { a: 1, b: undefined });
  });

  it("键顺序不影响", () => {
    assert.equal({ a: 1, b: 2 }, { b: 2, a: 1 });
  });

  it("值不同 / 数组长度不同 / 类型不同都判不等", () => {
    rejects(() => assert.equal({ a: 1 }, { a: 2 }));
    rejects(() => assert.equal([1, 2], [1, 2, 3]));
    rejects(() => assert.equal([1, 2, 3], [1, 2]));
    rejects(() => assert.equal({ a: 1 }, [1]));
    rejects(() => assert.equal(null, {}));
    rejects(() => assert.equal({ a: 1 }, { a: "1" }));
  });

  it("**多出来的键要判不等**——否则 equal 会退化成部分匹配", () => {
    rejects(() => assert.equal({ a: 1, b: 2 }, { a: 1 }));
    rejects(() => assert.equal({ a: 1 }, { a: 1, b: 2 }));
  });
});

describe("matches（部分匹配）", () => {
  it("只看列出来的键，多的不管", () => {
    assert.matches({ a: 1, b: 2, c: 3 }, { a: 1 });
    assert.matches({ ok: true, data: { x: 1, y: 2 } }, { data: { x: 1 } });
  });

  it("列出来的键对不上就失败", () => {
    rejects(() => assert.matches({ a: 1 }, { a: 2 }));
    rejects(() => assert.matches({ a: 1 }, { b: 1 }));
    rejects(() => assert.matches(undefined, { a: 1 }));
    rejects(() => assert.matches(null, { a: 1 }));
  });

  it("数组按长度 + 逐项部分匹配", () => {
    assert.matches([{ a: 1, b: 2 }], [{ a: 1 }]);
    rejects(() => assert.matches([{ a: 1 }], [{ a: 1 }, { a: 2 }]));
  });
});

describe("length / contains / notContains", () => {
  it("length", () => {
    assert.length([1, 2, 3], 3);
    assert.length("abc", 3);
    rejects(() => assert.length([1], 2));
    rejects(() => assert.length(undefined, 0));
  });

  it("contains 按深比较找，不是按引用", () => {
    assert.contains([{ a: 1 }], { a: 1 });
    assert.contains(["x"], "x");
    rejects(() => assert.contains([{ a: 1 }], { a: 2 }));
  });

  it("notContains", () => {
    assert.notContains([{ a: 1 }], { a: 2 });
    rejects(() => assert.notContains([{ a: 1 }], { a: 1 }));
  });
});

describe("defined / isUndefined", () => {
  it("defined 对 null 与 undefined 都失败", () => {
    assert.defined(0);
    assert.defined("");
    assert.defined(false);
    rejects(() => assert.defined(undefined));
    rejects(() => assert.defined(null));
  });

  it("isUndefined 只认 undefined", () => {
    assert.isUndefined(undefined);
    rejects(() => assert.isUndefined(null));
    rejects(() => assert.isUndefined(0));
  });
});

describe("数值与抛错", () => {
  it("atMost / greaterThan", () => {
    assert.atMost(3, 3);
    assert.atMost(2, 3);
    assert.greaterThan(4, 3);
    rejects(() => assert.atMost(4, 3));
    rejects(() => assert.greaterThan(3, 3));
  });

  it("throws 可以带消息模式", () => {
    assert.throws(() => {
      throw new Error("boom happened");
    });
    assert.throws(() => {
      throw new Error("boom happened");
    }, /boom/);
    rejects(() =>
      assert.throws(() => {
        throw new Error("boom");
      }, /nope/),
    );
    rejects(() => assert.throws(() => undefined));
  });

  it("doesNotThrow", () => {
    assert.doesNotThrow(() => undefined);
    rejects(() =>
      assert.doesNotThrow(() => {
        throw new Error("x");
      }),
    );
  });
});

describe("内置对象：只按「自有可枚举键」比会全判成相等，必须特判", () => {
  it("Date 按时刻比", () => {
    assert.equal(new Date(0), new Date(0));
    // 这一条是整个断言库最危险的洞：两个 Date 都没有自有可枚举键。
    rejects(() => assert.equal(new Date(0), new Date(999_999)));
    rejects(() => assert.equal(new Date(0), {}));
    rejects(() => assert.equal({}, new Date(0)));
  });

  it("Map 按内容比（键可以是对象）", () => {
    assert.equal(new Map([["a", 1]]), new Map([["a", 1]]));
    assert.equal(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]]));
    rejects(() => assert.equal(new Map([["a", 1]]), new Map()));
    rejects(() => assert.equal(new Map([["a", 1]]), new Map([["a", 2]])));
    rejects(() => assert.equal(new Map(), {}));
  });

  it("Set 按内容比", () => {
    assert.equal(new Set([1, 2]), new Set([2, 1]));
    assert.equal(new Set([{ a: 1 }]), new Set([{ a: 1 }]));
    rejects(() => assert.equal(new Set([1, 2]), new Set([9])));
    rejects(() => assert.equal(new Set([1]), new Set()));
  });

  it("Error 按 name + message 比", () => {
    assert.equal(new Error("x"), new Error("x"));
    rejects(() => assert.equal(new Error("x"), new Error("y")));
    rejects(() => assert.equal(new Error("x"), new TypeError("x")));
  });

  it("RegExp 按 source + flags 比", () => {
    assert.equal(/a/g, /a/g);
    rejects(() => assert.equal(/a/g, /a/i));
    rejects(() => assert.equal(/a/, /b/));
  });

  it("TypedArray 按字节比", () => {
    assert.equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]));
    rejects(() => assert.equal(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
    rejects(() => assert.equal(new Uint8Array([1]), new Uint8Array([1, 2])));
  });
});

describe("循环引用不该炸成 RangeError", () => {
  it("同构的循环判相等", () => {
    const a: Record<string, unknown> = { name: "x" };
    a["self"] = a;
    const b: Record<string, unknown> = { name: "x" };
    b["self"] = b;
    assert.equal(a, b);
  });

  it("循环里内容不同仍判不等，且抛的是我们自己的错误类型", () => {
    const a: Record<string, unknown> = { name: "x" };
    a["self"] = a;
    const b: Record<string, unknown> = { name: "y" };
    b["self"] = b;
    rejects(() => assert.equal(a, b));
  });

  it("matches 也不炸", () => {
    const a: Record<string, unknown> = { name: "x" };
    a["self"] = a;
    assert.matches(a, { name: "x" });
  });
});

describe("matches 与 toMatchObject 的行为要对齐", () => {
  it("**期望值里写了 `undefined` 的键，实际值上必须真的有这个键**", () => {
    // vitest 的 `toMatchObject({ reason: undefined })` 对 `{}` 是失败的——
    // 「我期望这里是 undefined」和「我没提这个键」是两回事。
    rejects(() => assert.matches({}, { reason: undefined }));
    assert.matches({ reason: undefined }, { reason: undefined });
  });

  it("期望值是普通对象时，实际值不能是数组", () => {
    // 不校验形状的话 `matches([1,2,3], { length: 3 })` 会通过。
    rejects(() => assert.matches([1, 2, 3], { length: 3 }));
  });

  it("数组要长度相同且逐项部分匹配", () => {
    assert.matches([{ a: 1, b: 2 }], [{ a: 1 }]);
    rejects(() => assert.matches([{ a: 1 }], [{ a: 1 }, { a: 2 }]));
    rejects(() => assert.matches({ a: 1 }, [{ a: 1 }]));
  });
});

describe("几条容易被当成「显然」的边角", () => {
  it("`equal(0, -0)` 判不等（跟 vitest 的 toEqual 一致，是有意的）", () => {
    rejects(() => assert.equal(0, -0));
    assert.equal(-0, -0);
  });

  it("`length` 接受任何带 `.length` 的东西——字符串也行", () => {
    assert.length("abc", 3);
    rejects(() => assert.length("abc", 4));
  });

  it("稀疏数组的空洞等同于 undefined", () => {
    assert.equal([, 1], [undefined, 1]);
  });
});

describe("异步断言", () => {
  it("rejects 认被拒绝的 promise，可带消息模式", async () => {
    await assert.rejects(() => Promise.reject(new Error("boom happened")));
    await assert.rejects(() => Promise.reject(new Error("boom happened")), /boom/);
    await expect(assert.rejects(() => Promise.resolve(1))).rejects.toThrow(ConformanceAssertionError);
    await expect(assert.rejects(() => Promise.reject(new Error("boom")), /nope/)).rejects.toThrow(
      ConformanceAssertionError,
    );
  });

  it("resolves 认正常返回的 promise", async () => {
    await assert.resolves(() => Promise.resolve(1));
    await expect(assert.resolves(() => Promise.reject(new Error("x")))).rejects.toThrow(ConformanceAssertionError);
  });

  it("**把 async 函数传给同步的 `throws` 会当场判失败**，不会留下未处理的 rejection", () => {
    rejects(() => assert.throws(() => Promise.reject(new Error("boom"))));
  });
});

describe("报错信息", () => {
  it("带上期望值与实际值，好让实现者知道自己差在哪", () => {
    let caught: unknown;
    try {
      assert.equal({ a: 1 }, { a: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConformanceAssertionError);
    const err = caught as ConformanceAssertionError;
    expect(err.expected).toEqual({ a: 2 });
    expect(err.actual).toEqual({ a: 1 });
    expect(err.message).toContain("期望");
    expect(err.message).toContain("实际");
  });
});
