import { expect } from "chai";

import { readFileSync } from "node:fs";
import loadWabt from "wabt";
import { URL } from "url"; // in Browser, the URL in native accessible on window
import {
  WasmModule,
  CodeSection,
  ImportSection,
  emscriptenSigToWasm,
  TypeSection,
  WASM_PRELUDE,
  insertSectionPrefix,
} from "../../../core/stack_switching/runtime_wasm.mjs";
import { createInvokeModule } from "../../../core/stack_switching/create_invokes.mjs";
import {
  createPromisingModule,
  createPromising,
  suspenderGlobal,
} from "../../../core/stack_switching/suspenders.mjs";

const __dirname = new URL(".", import.meta.url).pathname;

const { parseWat } = await loadWabt();

function fromWat(wat) {
  return parseWat("fake.wat", wat, {
    mutable_globals: true,
    exceptions: true,
  }).toBinary({}).buffer;
}

function fromWatFile(file) {
  return parseWat(
    file,
    readFileSync(__dirname + "wat/" + file, { encoding: "utf8" }),
    {
      mutable_globals: true,
      exceptions: true,
    },
  ).toBinary({}).buffer;
}

// Normally comes from Emscripten
function uleb128Encode(n, target) {
  if (n < 128) {
    target.push(n);
  } else {
    // prettier-ignore
    target.push((n % 128) | 128, n >> 7);
  }
}
globalThis.uleb128Encode = uleb128Encode;

function uleb128Decode(target, position) {
  let result = 0;
  let p = 1;
  let ndigits = 0;
  let more = true;
  const more_mask = 1 << 7;
  while (more) {
    const temp = target[position];
    more = temp & more_mask;
    // prettier-ignore
    const digit = temp & (~more_mask);
    result += digit * p;
    ndigits++;
    p <<= 7;
  }
  return [result, ndigits];
}

const sectionCodes = {
  type: 0x01,
  import: 0x02,
  function: 0x03,
  export: 0x07,
  code: 0x0a,
};

function findSection(mod, section) {
  // start after wasm_prelude
  const sectionCode = sectionCodes[section];
  let p = WASM_PRELUDE.length;
  while (true) {
    const [body_len, ndigits] = uleb128Decode(mod, p + 1);
    const prefix_len = 1 + ndigits;
    const total_len = prefix_len + body_len;
    if (mod[p] === sectionCode) {
      return mod.subarray(p, p + total_len);
    }
    p += total_len;
  }
}

// Monkey patch to prevent it from creating an actual WebAssembly.Module
// as the result so we can assert on the generated bytes.
const origWasmGenerate = WasmModule.prototype.generate;
WasmModule.prototype.generate = function () {
  return new Uint8Array(this._sections.flat());
};

function compareModules(result, expected) {
  for (const section of ["type", "import", "function", "export", "code"]) {
    it(section, () => {
      expect(findSection(result, section)).to.deep.equal(
        findSection(expected, section),
      );
    });
  }
  it("full module", () => {
    expect(result).to.deep.equal(expected);
  });
}

describe("dynamic wasm generation code", () => {
  describe("insertSectionPrefix", () => {
    it("works adds length and section code", () => {
      expect(insertSectionPrefix(0x3c, [1, 2, 3, 4])).to.deep.equal([
        0x3c, 4, 1, 2, 3, 4,
      ]);
    });
    it("insertSectionPrefix works when the length of the section has two digits in base 128", () => {
      const a2 = insertSectionPrefix(
        0xaa,
        Array.from({ length: 88 + 128 * 54 }).fill(0),
      );
      expect(a2.slice(0, 3)).to.deep.equal([0xaa, 88 | 128, 54]);
    });
  });

  describe("emscriptenSigToWasm", () => {
    it("v", () => {
      expect(emscriptenSigToWasm("v")).to.deep.equal({
        parameters: [],
        results: [],
      });
    });
    it("i", () => {
      expect(emscriptenSigToWasm("i")).to.deep.equal({
        parameters: [],
        results: ["i32"],
      });
    });
    it("j", () => {
      expect(emscriptenSigToWasm("j")).to.deep.equal({
        parameters: [],
        results: ["i64"],
      });
    });
    it("e", () => {
      expect(emscriptenSigToWasm("e")).to.deep.equal({
        parameters: [],
        results: ["externref"],
      });
    });
    it("iijfde", () => {
      expect(emscriptenSigToWasm("iijfde")).to.deep.equal({
        parameters: ["i32", "i64", "f32", "f64", "externref"],
        results: ["i32"],
      });
    });
  });
  describe("sections", () => {
    it("type section is generated correctly", () => {
      const types = new TypeSection();
      const a = types.addWasm({
        parameters: ["i32", "i32"],
        results: ["i32", "i32"],
      });
      const b = types.addEmscripten("ve");
      const c = types.addEmscripten("i");
      const d = types.addEmscripten("ii");
      const e = types.addEmscripten("vii");
      const typeSection = new Uint8Array(types.generate());

      // Note: it's an implementation detail that wat2wasm generates the imports
      // in the same order that they are used, but it seems to work.
      const comparisonModule = fromWat(`
        (module
          (type (func (param i32) (param i32) (result i32) (result i32)))
          (type (func (param externref)))
          (type (func (result i32)))
          (type (func (param i32) (result i32)))
          (type (func (param i32) (param i32)))
        )
      `);
      const expectedTypeSection = findSection(comparisonModule, "type");
      expect(typeSection).to.deep.equal(expectedTypeSection);
    });

    it("import section is generated correctly", () => {
      const imports = new ImportSection();
      imports.addTable("t");
      imports.addTag("tag", 0);
      imports.addFunction("blah", 0);
      imports.addGlobal("i32", "i32");
      imports.addGlobal("i64", "i64");
      imports.addGlobal("externref", "externref");
      const importSection = new Uint8Array(imports.generate());

      // Note: it's an implementation detail that wat2wasm generates the imports
      // in the same order that they appear in the wat but it seems to work.
      const comparisonModule = fromWat(`
        (module
          ;; addTable adds a table of type funcref with no limits
          (import "e" "t" (table 0 funcref))
          (import "e" "tag" (tag (param i32) (param i32)))
          (import "e" "blah" (func (param i32) (param i32)))
          ;; globals are all mutable
          (global (import "e" "i32") (mut i32))
          (global (import "e" "i64") (mut i64))
          (global (import "e" "externref") (mut externref))
        )
      `);
      const expectedImportSection = findSection(comparisonModule, "import");
      expect(importSection).to.deep.equal(expectedImportSection);
    });

    it("code section is generated correctly", () => {
      const code = new CodeSection("i32", "externref");
      code.local_get(7);
      code.local_set(3);
      code.local_tee(9);
      code.global_get(1);
      code.global_set(2);
      code.const("i32", 50);
      code.const("i64", 57);
      code.const("f32", ...Array(4).fill(0));
      code.const("f64", ...Array(8).fill(0));
      code.call(0);
      code.call_indirect(0);
      const codeSection = new Uint8Array(code.generate());

      const comparisonModule = fromWat(`
        (module
          (global $suspender (import "e" "s") (mut externref))
          (import "e" "f" (func $f (param i32) (result externref)))

          (func (export "o")
              (param i32) (result i32)
                (local $a i32)
                (local $b externref)
            (local.get 7)
            (local.set 3)
            (local.tee 9)
            (global.get 1)
            (global.set 2)
            (i32.const 50)
            (i64.const 57)
            (f32.const 0)
            (f64.const 0)
            (call $f)
            (call_indirect (param i32) (result externref))
          )
        )
      `);
      const expectedCodeSection = findSection(comparisonModule, "code");
      expect(codeSection.slice(2)).to.deep.equal(expectedCodeSection.slice(2));
    });
  });

  describe("full modules", () => {
    describe("example module", () => {
      const mod = new WasmModule();
      const types = new TypeSection();
      const save_tidx = types.addEmscripten("i");
      const restore_tidx = types.addEmscripten("vi");
      const export_tidx = types.addEmscripten("fei");
      mod.addSection(types);

      const imports = new ImportSection();
      imports.addFunction("save", save_tidx);
      imports.addFunction("restore", restore_tidx);
      mod.addImportSection(imports);
      mod.setExportType(export_tidx);

      const code = new CodeSection();
      mod.addSection(code);
      const result = mod.generate();
      const expected = fromWat(`
        (module
          (import "e" "save"    (func (result i32)))
          (import "e" "restore" (func (param i32)))
          (func (export "o")
              (param externref) (param i32) (result f32)
          )
        )
      `);

      compareModules(result, expected);
    });

    describe("createInvokeModule", () => {
      for (let sig of ["v", "vd", "fd", "dd", "jjjj"]) {
        describe(sig, () => {
          const result = createInvokeModule(sig);
          const expected = fromWatFile(`invoke_${sig}.wat`);
          compareModules(result, expected);
        });
      }
    });

    describe("createPromisingModule", () => {
      for (let sig of ["v", "vd", "fd", "dd", "jjjj"]) {
        describe(sig, () => {
          const result = createPromisingModule(emscriptenSigToWasm(sig));
          const expected = fromWatFile(`promising_${sig}.wat`);
          compareModules(result, expected);
        });
      }
    });

    it("createPromising", async () => {
      WasmModule.prototype.generate = origWasmGenerate;
      const bin = fromWat(`
        (module
          (global $suspender (import "e" "s") (mut externref))
          (import "e" "i" (func $i (param externref) (result i32)))
          (func (export "o") (result i32)
            global.get $suspender
            call $i
          )
        )
      `);
      const mod = new WebAssembly.Module(bin);
      function sleep(ms) {
        return new Promise((res) => setTimeout(res, ms));
      }
      async function f() {
        await sleep(20);
        return 7;
      }
      const i = new WebAssembly.Function(
        { parameters: ["externref"], results: ["i32"] },
        f,
        { suspending: "first" },
      );
      const inst = new WebAssembly.Instance(mod, {
        e: { i, s: suspenderGlobal },
      });
      const w = createPromising(inst.exports.o, suspenderGlobal);
      expect(w()).to.instanceOf(Promise);
      expect(await w()).to.equal(7);
    });
  });
});
