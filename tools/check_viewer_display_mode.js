const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "city-viewer", "index.html"), "utf8");
const LARGE_RESULT_COUNT = 25001;
let zoom = 8;
let pendingLoad;
let fallbackCount = 0;
let renderCount = 0;
const context = vm.createContext({
  state: { started: true, initializingView: false, mode: "overview", dispMode: "points", autoLoaded: true, dispAuto: true },
  map: { getZoom: () => zoom },
  els: {
    city: {}, loading: { style: {} },
    dispMode: { value: "points", options: [{}] },
  },
  FORCE_SCATTER: 20000, DEEP_IN: 15, DEEP_OUT: 12,
  prefAtCenter: () => "370500",
  updateCountySelect: () => {},
  ensureCityData: (city, callback) => { pendingLoad = callback; },
  renderMapPoints: () => { renderCount += 1; },
  selectProvince: () => { fallbackCount += 1; },
  showCityGrid: () => { fallbackCount += 1; },
});

function loadFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert(start >= 0, `Missing function: ${name}`);
  const end = source.indexOf("\n  function ", start + 1);
  assert(end > start, `Missing function boundary: ${name}`);
  vm.runInContext(source.slice(start, end), context);
}

for (const name of ["applyDispMode", "enforceDispMode", "applyZoomLod"]) loadFunction(name);
context.rerender = () => {
  context.enforceDispMode(LARGE_RESULT_COUNT);
  context.renderMapPoints();
};

context.applyDispMode();
assert.equal(typeof pendingLoad, "function");
assert.equal(context.state.autoLoaded, false);
assert.equal(context.state.dispAuto, false);
pendingLoad();
assert.equal(context.state.mode, "detail");
assert.equal(context.state.dispMode, "points", "Large results overwrote manual scatter selection");
for (zoom of [8, 11, 3]) context.applyZoomLod();
assert.equal(fallbackCount, 0, "Zoom triggered overview fallback after manual mode selection");
assert.equal(context.state.mode, "detail");
assert.equal(context.els.dispMode.value, "points");

context.state.dispMode = "density";
context.applyDispMode();
context.rerender();
assert.equal(context.state.dispMode, "density", "Manual density selection was overwritten");
context.state.dispMode = "points";
context.applyDispMode();
context.rerender();
assert.equal(context.state.dispMode, "points");

context.state.autoLoaded = true;
context.state.prevMode = "city";
context.state.prevCity = "370500";
zoom = 11;
context.applyZoomLod();
assert.equal(fallbackCount, 1, "Automatic zoom-loaded details no longer return to the grid");
assert(renderCount > 0);
console.log("PASS: manual scatter/density persists across large results and low zoom; automatic LOD still works");
