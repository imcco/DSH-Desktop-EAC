import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const {
  patchModelImageInputSource,
  patchModelImageInputToggle,
} = require('../scripts/patch-deps.js') as {
  patchModelImageInputSource(source: string): string | undefined;
  patchModelImageInputToggle(targetFile: string): boolean;
};

const prefix = 'fixture';
const helper = [
  '\t\tfunction modelDrafts(value) {',
  '\t\t\tif (!Array.isArray(value)) return [];',
  '\t\t\treturn value.map((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry : {});',
  '\t\t}',
].join('\n');
const deepSeekButton = [
  '\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t\t"aria-label": `${props.t("modelAdvanced")} ${String(index + 1)}`,',
].join('\n');
const genericButton = [
  '\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t"aria-label": `${t("modelAdvanced")} ${index + 1}`,',
].join('\n');
const fixture = [
  `const css = ".${prefix}_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;align-items:center;gap:6px;display:grid}";`,
  `\t\t\t"modelRow": "${prefix}_modelRow",`,
  helper,
  deepSeekButton,
  genericButton,
  '\t\t\tmodelName: "Display name",',
  '\t\t\tmodelName: "显示名称",',
].join('\n');

const legacyHelper = [
  helper,
  '\t\t/** Whether one model explicitly declares native image input. */',
  '\t\tfunction modelAcceptsImage(model) {',
  '\t\t\treturn Array.isArray(model["input"]) && model["input"].includes("image");',
  '\t\t}',
  '\t\t/** Render the model-level native image-input declaration switch. */',
  '\t\tfunction ModelImageInputSwitch(props) {',
  '\t\t\tconst enabled = modelAcceptsImage(props.model);',
  '\t\t\tconst label = props.t("modelImageInput");',
  '\t\t\treturn (0, react_jsx_runtime.jsxs)("button", {',
  '\t\t\t\ttype: "button",',
  '\t\t\t\trole: "switch",',
  '\t\t\t\t"aria-checked": enabled,',
  '\t\t\t\t"aria-label": `${label} ${String(props.index + 1)}`,',
  '\t\t\t\ttitle: props.t("modelImageInputHint"),',
  '\t\t\t\tclassName: `${ModelsSection_module_css_default["modelImageSwitch"]}${enabled ? ` ${ModelsSection_module_css_default["modelImageSwitchOn"]}` : ""}`,',
  '\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\tonClick: () => {',
  '\t\t\t\t\tprops.onChange(enabled ? void 0 : ["text", "image"]);',
  '\t\t\t\t},',
  '\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageLabel"],',
  '\t\t\t\t\tchildren: label',
  '\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageTrack"],',
  '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelImageThumb"] })',
  '\t\t\t\t})]',
  '\t\t\t});',
  '\t\t}',
].join('\n');
const legacyCss = [
  `.${prefix}_modelImageSwitch{height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:0 4px;font-size:11px;line-height:18px;display:inline-flex;white-space:nowrap;/*dsh-desktop-model-image-input*/}`,
  `.${prefix}_modelImageSwitch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
  `.${prefix}_modelImageSwitch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}`,
  `.${prefix}_modelImageSwitch:disabled{cursor:default;opacity:.4}`,
  `.${prefix}_modelImageSwitchOn{color:var(--dsw-alias-label-primary)}`,
  `.${prefix}_modelImageLabel{display:inline}`,
  `.${prefix}_modelImageTrack{background:var(--dsw-alias-border-l3);border-radius:8px;flex:none;width:28px;height:16px;padding:2px;display:block}`,
  `.${prefix}_modelImageThumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:12px;height:12px;transition:transform .12s;display:block}`,
  `.${prefix}_modelImageSwitchOn .${prefix}_modelImageTrack{background:var(--dsw-alias-brand-primary)}`,
  `.${prefix}_modelImageSwitchOn .${prefix}_modelImageThumb{transform:translate(12px)}`,
  `@media (max-width:760px){.${prefix}_modelImageLabel{display:none}.${prefix}_modelImageSwitch{padding:0 2px}}`,
].join('');
const legacyFixture = [
  `const css = ".${prefix}_modelRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto auto;align-items:center;gap:6px;display:grid}${legacyCss}";`,
  `\t\t\t"modelRow": "${prefix}_modelRow",`,
  `\t\t\t"modelImageLabel": "${prefix}_modelImageLabel",`,
  `\t\t\t"modelImageSwitch": "${prefix}_modelImageSwitch",`,
  `\t\t\t"modelImageSwitchOn": "${prefix}_modelImageSwitchOn",`,
  `\t\t\t"modelImageThumb": "${prefix}_modelImageThumb",`,
  `\t\t\t"modelImageTrack": "${prefix}_modelImageTrack",`,
  legacyHelper,
].join('\n');

test('model image-input patch adds one inline switch to both model editors', () => {
  const patched = patchModelImageInputSource(fixture);
  assert.ok(patched);
  assert.equal(patched.match(/ModelImageInputSwitch, \{/g)?.length, 2);
  assert.match(patched, /grid-template-columns:minmax\(0,1\.4fr\) minmax\(0,1fr\) auto auto auto/);
  assert.match(patched, /role: "switch"/);
  assert.match(patched, /modelImageInput: "图片输入"/);
  assert.match(patched, /modelImageInput: "Image input"/);
});

test('image switch is compact and skin-aware without a repeated visible label', () => {
  const patched = patchModelImageInputSource(fixture);
  assert.ok(patched);
  assert.doesNotMatch(patched, /modelImageLabel/);
  assert.doesNotMatch(patched, /children: label/);
  assert.match(patched, /background:transparent;border:1px solid var\(--dsw-alias-border-l3\)/);
  assert.match(patched, /var\(--dsw-alias-state-success-primary,var\(--dsw-alias-brand-primary\)\)/);
  assert.match(patched, /background:var\(--dsw-alias-label-tertiary\)/);
  assert.doesNotMatch(patched, /#[0-9a-f]{3,8}/i);
});

test('legacy labeled switch upgrades to the compact skin-aware v2 style', () => {
  const upgraded = patchModelImageInputSource(legacyFixture);
  assert.ok(upgraded);
  assert.match(upgraded, /dsh-desktop-model-image-input-v2/);
  assert.doesNotMatch(upgraded, /modelImageLabel/);
  assert.doesNotMatch(upgraded, /children: label/);
  assert.equal(patchModelImageInputSource(upgraded), upgraded);
});

test('image switch writes native modalities when enabled and deletes the override when disabled', () => {
  const patched = patchModelImageInputSource(fixture);
  assert.ok(patched);
  assert.match(patched, /props\.onChange\(enabled \? void 0 : \["text", "image"\]\)/);
  assert.match(patched, /update\(index, "input", input\)/);
  assert.match(patched, /patch\(index, \{ input \}\)/);
  assert.doesNotMatch(patched, /enabled \? \["text"\]/);
});

test('model image-input source transform is idempotent', () => {
  const once = patchModelImageInputSource(fixture);
  assert.ok(once);
  assert.equal(patchModelImageInputSource(once), once);
});

test('file patch applies atomically and reports success on a second run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-image-input-'));
  const file = join(dir, 'client.js');
  try {
    writeFileSync(file, fixture);
    assert.equal(patchModelImageInputToggle(file), true);
    const once = readFileSync(file, 'utf8');
    assert.equal(patchModelImageInputToggle(file), true);
    assert.equal(readFileSync(file, 'utf8'), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model image-input patch refuses an unknown upstream shape', () => {
  assert.equal(patchModelImageInputSource('const upstreamChanged = true;'), undefined);
});
