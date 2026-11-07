// The speech probe: opens a board in one browser, with the browser's fake
// microphone, and records what the browser offers for speech recognition and
// what the page does with it. It checks that the microphone button is enabled
// only where the browser offers recognition, that the page doesn't start
// recognition before the person presses the button and agrees, and that the
// page says where recognition runs before it starts. It then agrees, and
// records whether recognition started or the error the browser reported. A
// browser on a runner receives only the fake microphone's tone, so the probe
// records the outcome and doesn't wait for a transcript entry.
//
// Settings, from the environment:
//   BROWSER        chromium (Playwright's Chromium), chrome (the runner's Google Chrome),
//                  msedge (the runner's Microsoft Edge) or firefox (default: chromium)
//   PAGE_URL       the page to open; left empty, this script serves the local build
//   WAIT_SECONDS   how long each wait lasts before the probe records it as unanswered (default: 60)
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { preview } from 'vite';

const browserName = process.env.BROWSER || 'chromium';
const waitMs = Number(process.env.WAIT_SECONDS || '60') * 1000;
const screenshot = `speech-${browserName}.png`;

let server;
let pageUrl = process.env.PAGE_URL;
if (!pageUrl) {
  server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  });
  pageUrl = 'http://127.0.0.1:4173/';
}
const link = new URL(pageUrl);
link.hash = new URLSearchParams({
  room: `speech-${randomBytes(8).toString('hex')}`,
  key: randomBytes(16).toString('hex'),
}).toString();

// The fake device answers the microphone with a tone, and the fake UI grants it without a prompt.
const fakeMedia = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const launchers = {
  chromium: () => chromium.launch({ args: fakeMedia }),
  chrome: () => chromium.launch({ channel: 'chrome', args: fakeMedia }),
  msedge: () => chromium.launch({ channel: 'msedge', args: fakeMedia }),
  firefox: () =>
    firefox.launch({
      firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true },
    }),
};
const launch = launchers[browserName];
if (launch === undefined) throw new Error(`BROWSER is ${browserName}, which isn't chromium, chrome, msedge or firefox`);
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
if (browserName !== 'firefox') await context.grantPermissions(['microphone'], { origin: link.origin });
// Count each start of recognition, whichever name the page reaches the class by, and log each call
// of the on-device check before the browser answers it, so that the log shows the last call before a crash.
await context.addInitScript(() => {
  window.speechStarts = 0;
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    const Class = window[name];
    if (typeof Class !== 'function') continue;
    const start = Class.prototype.start;
    if (typeof start === 'function' && !start.counted) {
      const counted = function (...args) {
        window.speechStarts += 1;
        console.log('speech probe: start()');
        return start.apply(this, args);
      };
      counted.counted = true;
      Class.prototype.start = counted;
    }
    for (const check of ['available', 'install']) {
      const original = Class[check];
      if (typeof original !== 'function' || original.counted) continue;
      const counted = function (...args) {
        console.log(`speech probe: ${check}(${JSON.stringify(args)})`);
        return original.apply(this, args);
      };
      counted.counted = true;
      Class[check] = counted;
    }
  }
});
const page = await context.newPage();
const calls = [];
let crashed = false;
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('speech probe: ')) calls.push(text.slice('speech probe: '.length));
  console.log(`[${browserName} console.${message.type()}] ${text}`);
});
page.on('pageerror', (error) => console.log(`[${browserName} page error] ${error.message}`));
page.on('crash', () => {
  crashed = true;
  console.log(`${browserName}: the tab crashed`);
});

/** Runs a person's act, such as a click, and answers false where the tab crashed during it. */
async function act(run) {
  try {
    await run();
    return !crashed;
  } catch (error) {
    if (crashed) return false;
    throw error;
  }
}
const crashOutcome = () => `the tab crashed after the page called ${calls.length === 0 ? 'none of start, available and install' : calls.join(', ')}`;

/** The page's answer, or `fallback` where the page doesn't answer within the wait, as where the browser's check hangs. */
async function within(promise, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), waitMs);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The speech state once it is one of `kinds`, or `{ kind: 'unanswered' }` after the wait. */
function stateOf(kinds) {
  return within(
    page.evaluate(
      (wanted) =>
        new Promise((resolve) => {
          const speech = window.chalkline.speech;
          let stop = () => {};
          const check = (state) => {
            if (!wanted.includes(state.kind)) return false;
            stop();
            resolve(state);
            return true;
          };
          if (!check(speech.state())) stop = speech.onState(check);
        }),
      kinds,
    ).catch((error) => {
      if (crashed) return { kind: 'crashed' };
      throw error;
    }),
    { kind: 'unanswered' },
  );
}

const starts = () => within(page.evaluate(() => window.speechStarts), 'unanswered');

const record = { browser: browserName, version: browser.version(), steps: [] };
function step(text) {
  record.steps.push(text);
  console.log(`${browserName}: ${text}`);
}
function contract(holds, text) {
  if (!holds) throw new Error(`the page broke its contract: ${text}`);
}

try {
  await page.goto(link.toString());
  await page.waitForFunction(() => window.chalklineReady !== undefined);
  await page.evaluate(() => window.chalklineReady);
  record.offers = await page.evaluate(() => {
    const Class = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    return {
      SpeechRecognition: typeof window.SpeechRecognition === 'function',
      webkitSpeechRecognition: typeof window.webkitSpeechRecognition === 'function',
      processLocally: typeof Class === 'function' && 'processLocally' in Class.prototype,
      available: typeof Class?.available === 'function',
      install: typeof Class?.install === 'function',
      language: navigator.language,
      userAgent: navigator.userAgent,
    };
  });
  const offered = record.offers.SpeechRecognition || record.offers.webkitSpeechRecognition;
  step(`opened ${link.origin}${link.pathname}; the browser offers ${JSON.stringify(record.offers)}`);

  const mic = page.locator('#mic');
  await mic.waitFor({ state: 'visible', timeout: 30_000 });
  const disabled = await mic.isDisabled();
  contract(disabled === !offered, `the microphone button is ${disabled ? 'disabled' : 'enabled'} where the browser ${offered ? 'offers' : "doesn't offer"} recognition`);
  const first = await page.evaluate(() => window.chalkline.speech.state());
  contract(first.kind === (offered ? 'off' : 'unsupported'), `speech starts as ${first.kind}`);
  contract((await starts()) === 0, 'recognition started before the person pressed the microphone button');
  step(`the microphone button is ${disabled ? 'disabled' : 'enabled'}, and speech is ${first.kind}`);

  if (!offered) {
    record.outcome = 'unsupported';
  } else {
    const asked = (await act(() => mic.click())) ? await stateOf(['asking', 'off']) : { kind: 'crashed' };
    if (asked.kind === 'crashed' || crashed) {
      record.outcome = crashOutcome();
      step(`after the microphone button, ${record.outcome}`);
    } else if (asked.kind !== 'asking') {
      record.outcome = asked.kind === 'unanswered' ? `the browser's check didn't answer in ${waitMs / 1000} s` : `off: ${asked.error ?? 'no error'}`;
      step(`after the microphone button, ${record.outcome}`);
    } else {
      record.place = asked.place;
      const panel = page.locator('#transcript');
      contract(await panel.isVisible(), "the transcript panel isn't open while the page asks");
      contract((await panel.innerText()).includes(asked.notice), "the panel doesn't show where recognition runs");
      contract((await starts()) === 0, 'recognition started before the person agreed');
      step(`the page asks first, recognition on the ${asked.place}: "${asked.notice}"`);

      const agreed = await act(() => page.getByRole('button', { name: 'Start listening' }).click());
      const after = agreed ? await stateOf(['listening', 'off']) : { kind: 'crashed' };
      const started = crashed ? calls.filter((call) => call === 'start()').length : await starts();
      if (after.kind === 'crashed' || crashed) {
        record.outcome = crashOutcome();
        step(`after Start listening, ${record.outcome}`);
      } else if (after.kind === 'listening') {
        contract(typeof started === 'number' && started >= 1, 'speech says it listens, and recognition never started');
        record.outcome = `listening, recognition on the ${after.place}`;
        step(`after Start listening, ${record.outcome}, ${started} start(s)`);
        await mic.click();
        const off = await stateOf(['off']);
        contract(off.kind === 'off', `the microphone button didn't turn speech off: ${off.kind}`);
        step('the microphone button turned speech off');
      } else if (after.kind === 'off') {
        record.outcome = `off after ${started} start(s): ${after.error ?? 'no error'}`;
        step(`after Start listening, ${record.outcome}`);
      } else {
        record.outcome = `recognition didn't start or report an error in ${waitMs / 1000} s, after ${started} start(s)`;
        step(record.outcome);
      }
    }
  }
  if (!crashed) await within(page.screenshot({ path: screenshot }), undefined);
  record.calls = calls;
  console.log(`${browserName}: ${JSON.stringify(record)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `### Speech in ${browserName} ${record.version}`,
      '',
      `Offers: ${JSON.stringify(record.offers)}`,
      '',
      ...record.steps.map((text) => `- ${text}`),
      '',
      `Outcome: ${record.outcome}`,
      '',
      `Calls the page made: ${calls.join(', ') || 'none'}`,
      '',
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`${browserName}: the probe failed: ${error instanceof Error ? error.stack : error}`);
  console.error(`${browserName}: what it recorded: ${JSON.stringify(record)}`);
  await within(page.screenshot({ path: screenshot }), undefined).catch(() => {});
} finally {
  // A page whose check hangs can hold the browser's close, so the probe stops after a bounded wait.
  await within(browser.close(), undefined).catch(() => {});
  await server?.close();
  process.exit();
}
