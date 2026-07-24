/**
 * Browser smoke: NavKit restore → green overlay + Workbench legacy upload gone.
 *
 *   node scripts/smoke-navkit-navigate.mjs [baseUrl] [navkitZipPath]
 *
 * Defaults: http://127.0.0.1:5173 and /tmp/navkit-meadow-067.zip
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let puppeteer;
try {
  puppeteer = require('/tmp/puppeteer-smoke/node_modules/puppeteer');
} catch {
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.error(
      'Install puppeteer (e.g. npm i puppeteer in /tmp/puppeteer-smoke) before running smoke.'
    );
    process.exit(1);
  }
}

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const NAVKIT =
  process.argv[3] ||
  (existsSync('/Users/eeisaman/Downloads/navkit-meadow.zip')
    ? '/Users/eeisaman/Downloads/navkit-meadow.zip'
    : '/tmp/navkit-meadow-067.zip');

/** UI hosts often keep applyNavArtifacts logs in-app only; Viewer/Controller log to console. */
const RESTORE_OK =
  /Navmesh visualized|Crowd simulation initialized|R3F Recast crowd restored|Walkable overlay|NavKit loaded/i;
const OVERLAY_OK =
  /Navmesh visualized|Walkable overlay|showNavMesh|green navmesh/i;

if (!existsSync(NAVKIT)) {
  console.error(`Missing NavKit zip: ${NAVKIT}`);
  process.exit(1);
}

const NAVKIT_LOAD_MS = 180_000;
const failed = [];
const ok = (msg) => console.log(`OK: ${msg}`);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed.push(msg);
};

const waitForConsoleMatch = (page, pattern, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('console', onConsole);
      reject(new Error(`Timeout waiting for console /${pattern}/`));
    }, timeoutMs);
    const onConsole = (msg) => {
      const text = msg.text();
      if (pattern.test(text)) {
        clearTimeout(timer);
        page.off('console', onConsole);
        resolve(text);
      }
    };
    page.on('console', onConsole);
  });

const smokeWorkbench = async (browser) => {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (/UPLOAD NAV ARTIFACTS\s*\(LEGACY\)/i.test(bodyText)) {
    fail('Workbench still shows UPLOAD NAV ARTIFACTS (LEGACY)');
  } else {
    ok('Workbench has no UPLOAD NAV ARTIFACTS (LEGACY)');
  }
  if (!(await page.$('#downloadNavKitToolbarBtn'))) {
    fail('Workbench missing #downloadNavKitToolbarBtn');
  } else {
    ok('Workbench Download NavKit toolbar button present');
  }

  const successWait = waitForConsoleMatch(page, RESTORE_OK, NAVKIT_LOAD_MS);
  const input = await page.$('#localFileInput');
  if (!input) {
    fail('Workbench #localFileInput missing');
    await page.close();
    return;
  }
  await input.uploadFile(path.resolve(NAVKIT));
  try {
    const hit = await successWait;
    ok(`Workbench NavKit restore log: ${hit.slice(0, 120)}`);
  } catch (e) {
    fail(`Workbench NavKit restore: ${e.message}`);
    console.log('--- last workbench logs ---');
    console.log(logs.slice(-40).join('\n'));
    await page.close();
    return;
  }

  await sleep(1500);
  if (logs.some((l) => OVERLAY_OK.test(l))) {
    ok('Workbench restored walkable overlay');
  } else {
    fail('Workbench missing walkable overlay log');
  }
  if (logs.some((l) => /Crowd simulation initialized|Recast crowd restored/i.test(l))) {
    ok('Workbench Recast crowd restored');
  } else {
    fail('Workbench missing Recast crowd restored log');
  }
  await page.close();
};

const smokeHost = async (browser, route, label) => {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0', timeout: 90_000 });

  // Hidden file input used by CHOOSE LOCAL / drop zone
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length === 0) {
    fail(`${label}: no file input`);
    await page.close();
    return;
  }
  // Prefer the splat/navkit picker (accept includes zip), not legacy nav-artifacts-only
  let picker = null;
  for (const el of fileInputs) {
    const accept = await el.evaluate((n) => n.getAttribute('accept') || '');
    if (accept.includes('.zip') || accept.includes('zip') || accept.includes('.ply')) {
      picker = el;
      break;
    }
  }
  picker = picker || fileInputs[0];

  const successWait = waitForConsoleMatch(page, RESTORE_OK, NAVKIT_LOAD_MS);
  await picker.uploadFile(path.resolve(NAVKIT));
  try {
    const hit = await successWait;
    ok(`${label} NavKit restore log: ${hit.slice(0, 120)}`);
  } catch (e) {
    fail(`${label} NavKit restore: ${e.message}`);
    console.log(`--- last ${label} logs ---`);
    console.log(logs.slice(-50).join('\n'));
    await page.close();
    return;
  }

  await sleep(2000);
  const hasOverlay = logs.some((l) => OVERLAY_OK.test(l));
  const hasCrowd = logs.some((l) =>
    /Crowd simulation initialized|Recast crowd restored|R3F Recast crowd restored|NavKit loaded|Crowd ready/i.test(
      l
    )
  );
  const hang =
    logs.some((l) => /Rendering Gaussian splat/i.test(l)) &&
    !logs.some((l) => RESTORE_OK.test(l));
  if (hasOverlay) {
    ok(`${label} restored walkable overlay`);
  } else {
    fail(`${label} missing walkable overlay log`);
  }
  if (hasCrowd) {
    ok(`${label} crowd / NavKit complete`);
  } else {
    fail(`${label} crowd restore incomplete`);
  }
  if (hang) {
    fail(`${label} appears stuck on Rendering Gaussian splat`);
  } else {
    ok(`${label} did not hang on splat load`);
  }
  await page.close();
};

const main = async () => {
  console.log(`Smoke NavKit navigate @ ${BASE}`);
  console.log(`Zip: ${NAVKIT}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  try {
    await smokeWorkbench(browser);
    await smokeHost(browser, '/vuetify', 'Vuetify');
    await smokeHost(browser, '/react', 'React');
  } finally {
    await browser.close();
  }
  if (failed.length) {
    console.error(`\n${failed.length} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll NavKit navigate smokes passed.');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
