require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Builder, By, until, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

// ===== CONFIG =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONFIG_SHEET = '_config';
const SHEET_NAME = process.env.SHEET_NAME;
const CREDENTIALS_PATH = path.join(__dirname, process.env.CREDENTIALS_PATH || 'service-account.json');
const USERNAME = process.env.HOLEX_USERNAME;
const PASSWORD = process.env.HOLEX_PASSWORD;
const LOGIN_URL = process.env.LOGIN_URL;
const ANTHURIUM_BASE_URL = process.env.ANTHURIUM_BASE_URL;
const LOG_PATH = path.join(__dirname, process.env.LOG_PATH || 'scraper.log');
const STATUS_CELL = 'F5';

// ===== UTILITY FUNCTIONS =====
function log(message) {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}\n`;
  console.log(fullMessage.trim());
  fs.appendFileSync(LOG_PATH, fullMessage);
}

function sanitize(text = '') {
  if (!text) return 'N/A';
  return String(text)
    .replace('â‚¬', '€')
    .replace(/[^\x20-\x7E€$]/g, '')
    .trim();
}

function getUaeTimeFormatted() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '');
}

function formatRuntime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  if (seconds > 0) return `${seconds}s`;
  return `${ms}ms`;
}

function getColorNameFromRGB(rgb) {
  return rgb || 'N/A';
}

function ensureDebugDir() {
  const debugDir = path.join(__dirname, 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  return debugDir;
}

function detectChallenge(text = '') {
  const lower = text.toLowerCase();
  const challengeWords = [
    'just a moment',
    'checking your browser',
    'verify you are human',
    'access denied',
    'attention required',
    'cloudflare',
    'captcha',
    'performing security verification',
    'malicious bots',
  ];
  return challengeWords.find((word) => lower.includes(word)) || null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveDebugState(driver, name) {
  try {
    const debugDir = ensureDebugDir();
    const safeName = name.replace(/[^\w.-]/g, '_');

    const title = await driver.getTitle().catch(() => '');
    const url = await driver.getCurrentUrl().catch(() => '');
    const html = await driver.getPageSource().catch(() => '');
    const bodyText = await driver.findElement(By.css('body')).getText().catch(() => '');

    fs.writeFileSync(path.join(debugDir, `${safeName}.html`), html || '');
    fs.writeFileSync(path.join(debugDir, `${safeName}.txt`), bodyText || '');

    const screenshot = await driver.takeScreenshot().catch(() => null);
    if (screenshot) {
      fs.writeFileSync(path.join(debugDir, `${safeName}.png`), screenshot, 'base64');
    }

    log(`🧾 Debug saved: ${safeName}`);
    log(`🌐 Debug URL (${safeName}): ${url}`);
    log(`📄 Debug Title (${safeName}): ${title}`);
    log(`📝 Debug Body sample (${safeName}): ${(bodyText || '').slice(0, 800)}`);
  } catch (err) {
    log(`ℹ️ Failed saving debug state "${name}": ${err.message}`);
  }
}

// ===== GOOGLE SHEETS =====
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return await auth.getClient();
}

async function updateStatus(authClient, status, startTime, errorMessage) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  let statusText;

  if (status === 'running') {
    statusText = '🟡 Scraping in progress...';
  } else {
    const runtime = formatRuntime(Date.now() - startTime);
    const timestamp = getUaeTimeFormatted();

    switch (status) {
      case 'success':
        statusText = `✅ ${timestamp} — ${runtime}`;
        break;
      case 'error':
        statusText = `❌ Failed ${timestamp} — ${runtime}${errorMessage ? ` - ${errorMessage}` : ''}`;
        break;
      case 'no-products':
        statusText = `⚠️ No products found ${timestamp} — ${runtime}`;
        break;
      case 'no-urls':
        statusText = `⚠️ No URLs provided ${timestamp} — ${runtime}`;
        break;
      case 'date-disabled':
        statusText = `⚠️ Date disabled ${timestamp} — ${runtime}`;
        break;
      default:
        statusText = `${timestamp} — ${runtime}`;
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!${STATUS_CELL}`,
    valueInputOption: 'RAW',
    resource: { values: [[statusText]] },
  });

  log(`📌 Updated status in ${STATUS_CELL}: ${statusText}`);
}

async function readPackingDate(authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!C5`,
  });
  const date = res.data.values?.[0]?.[0] || '';
  log(`📌 Packing date from sheet: ${date}`);
  return date;
}

async function writeHeaders(authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:R1`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        'Name',
        'Tag',
        'Image URL',
        'Origin',
        'Length',
        'Diameter',
        'No of Buds',
        'Weight',
        'Certificate',
        'Farm',
        'Color',
        'First Price',
        'Packing Value',
        'Available Quantity',
        'Product URL',
        'Second Price',
        'Third Price',
        'Time',
      ]],
    },
  });
  log('✅ Header row written.');
}

async function writeProducts(authClient, rows, isFirstUrl = false) {
  if (!rows || !rows.length) return;
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  if (isFirstUrl) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:R`,
    });
    log('🧹 Old product data cleared (all columns).');
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });
  const startRow = (res.data.values?.length || 1) + 1;

  const values = rows.map((p) => {
    if (p.name && p.name.startsWith('No products found')) return [p.name];

    const secondPriceCombined =
      p.secondPrice && p.second_quantity ? `${p.secondPrice} × ${p.second_quantity}` : 'N/A';
    const thirdPriceCombined =
      p.thirdPrice && p.third_quantity ? `${p.thirdPrice} × ${p.third_quantity}` : 'N/A';

    return [
      p.name || 'N/A',
      p.tag || 'N/A',
      p.imgUrl || 'N/A',
      p.origin || 'N/A',
      p.length || 'N/A',
      p.diameter || 'N/A',
      p.noofbuds || 'N/A',
      p.weight || 'N/A',
      p.certificate || 'N/A',
      p.farm || 'N/A',
      p.color || 'N/A',
      p.stemPrice ? `${p.stemPrice} × ${p.quantity || 'N/A'}` : 'N/A',
      p.first_quantity || 'N/A',
      p.available_quantity || 'N/A',
      p.productUrl || 'N/A',
      secondPriceCombined,
      thirdPriceCombined,
      p.time || getUaeTimeFormatted(),
    ];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${startRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });

  log(`✅ Wrote ${rows.length} rows starting at row ${startRow}.`);
}

// ===== SELENIUM HELPERS =====
async function createDriver() {
  const options = new chrome.Options();
  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1366,768',
    '--disable-blink-features=AutomationControlled'
  );

  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

  await driver.manage().setTimeouts({
    implicit: 0,
    pageLoad: 120000,
    script: 120000,
  });

  return driver;
}

async function login(driver) {
  log('🔐 Logging in...');

  await driver.get(LOGIN_URL);
  await sleep(5000);
  await saveDebugState(driver, 'login-page-before-submit');

  const initialTitle = await driver.getTitle().catch(() => '');
  const initialBody = await driver.findElement(By.css('body')).getText().catch(() => '');
  const initialChallenge = detectChallenge(`${initialTitle}\n${initialBody}`);

  if (initialChallenge) {
    throw new Error(`Security / bot challenge detected before login: ${initialChallenge}`);
  }

  const usernameField = await driver.wait(until.elementLocated(By.css('#j_username')), 30000);
  const passwordField = await driver.wait(until.elementLocated(By.css('#j_password')), 30000);
  const loginButton = await driver.wait(until.elementLocated(By.css('button.primary_button')), 30000);

  log('✅ Username field is visible');
  await usernameField.clear();
  await usernameField.sendKeys(USERNAME);
  log('✅ Username filled');

  log('✅ Password field is visible');
  await passwordField.clear();
  await passwordField.sendKeys(PASSWORD);
  log('✅ Password filled');

  await loginButton.click();
  log('✅ Login button clicked');

  await sleep(12000);
  await saveDebugState(driver, 'login-page-after-submit');

  const afterTitle = await driver.getTitle().catch(() => '');
  const afterUrl = await driver.getCurrentUrl().catch(() => '');
  const afterBody = await driver.findElement(By.css('body')).getText().catch(() => '');
  const afterChallenge = detectChallenge(`${afterTitle}\n${afterBody}`);

  log(`🌐 URL after login click: ${afterUrl}`);
  log(`📄 Title after login click: ${afterTitle}`);

  if (afterChallenge) {
    throw new Error(`Blocked by Cloudflare / anti-bot challenge after login: ${afterChallenge}`);
  }

  log('✅ Login confirmed.');
}

async function closePopup(driver) {
  const selectors = [
    '#cboxClose',
    '.fancybox-close',
    '.popup-close',
    '.modal-close',
    '.close-popup',
  ];

  for (const selector of selectors) {
    try {
      const els = await driver.findElements(By.css(selector));
      if (els.length) {
        await els[0].click();
        log('🧼 Closed popup.');
        return;
      }
    } catch {}
  }
}

async function autoScroll(driver) {
  let prevHeight = await driver.executeScript('return document.body.scrollHeight');
  for (let i = 0; i < 20; i++) {
    await driver.executeScript('window.scrollBy(0, window.innerHeight);');
    await sleep(1500);
    const newHeight = await driver.executeScript('return document.body.scrollHeight');
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
  }
  log('✅ Scrolling complete.');
}

async function selectPackingDate(driver, dateStr) {
  log(`📅 Selecting packing date: ${dateStr}`);

  const [month, day, year] = dateStr.split('/');
  const formattedDate = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;

  try {
    await driver.executeScript(`
      const el = document.querySelector('div.alert, div.hl_notification, header.js-mainHeader .hlx_notification');
      if (el) el.remove();
    `);
  } catch {}

  const pageTitle = await driver.getTitle().catch(() => '');
  const bodyText = await driver.findElement(By.css('body')).getText().catch(() => '');
  const challenge = detectChallenge(`${pageTitle}\n${bodyText}`);

  if (challenge) {
    await saveDebugState(driver, 'challenge-before-date-select');
    throw new Error(`Blocked by Cloudflare / anti-bot challenge before date selection: ${challenge}`);
  }

  const icons = await driver.findElements(By.css('div.js-custom_datepicker i.js-calendar_icon'));
  if (!icons.length) {
    await saveDebugState(driver, 'calendar-not-found');
    throw new Error('Calendar icon not found. Page may not be logged in, may be blocked, or layout changed.');
  }

  await icons[0].click();
  log('🟢 Calendar icon clicked.');

  await driver.wait(until.elementLocated(By.css('div.js-custom_datepicker table')), 15000);

  const targetMonthYear = new Date(`${year}-${month}-01`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  for (let i = 0; i < 12; i++) {
    const header = await driver.findElement(By.css('div.js-custom_datepicker th.picker-switch')).getText();
    if (header.trim() === targetMonthYear) break;

    const nextBtns = await driver.findElements(By.css('div.js-custom_datepicker th.next'));
    if (!nextBtns.length) {
      throw new Error(`Cannot find next month button. Calendar stuck at ${header}`);
    }

    await nextBtns[0].click();
    await sleep(500);
  }

  const dateCells = await driver.findElements(By.css(`div.js-custom_datepicker td[data-day="${formattedDate}"]`));
  if (!dateCells.length) {
    throw new Error(`Date cell for ${formattedDate} not found`);
  }

  const classList = await dateCells[0].getAttribute('class');
  if ((classList || '').includes('disabled')) {
    log(`❌ Date ${formattedDate} is disabled and cannot be selected.`);
    return false;
  }

  await dateCells[0].click();
  log(`✅ Date selected: ${formattedDate}`);

  try {
    const continueBtn = await driver.wait(
      until.elementLocated(By.css('button.confirm_select_date')),
      3000
    );
    await continueBtn.click();
    log('✅ Confirmed date selection by clicking Continue.');
    await sleep(2000);
  } catch {
    log('ℹ️ No confirmation popup appeared.');
  }

  return true;
}

// ===== SCRAPING PRODUCTS =====
async function scrapeProducts(driver) {
  const results = [];
  const cards = await driver.findElements(By.css('div.product-item'));
  const time = getUaeTimeFormatted();

  for (const product of cards) {
    try {
      async function getTextSafe(selector) {
        try {
          return sanitize(await product.findElement(By.css(selector)).getText());
        } catch {
          return 'N/A';
        }
      }

      async function getAttrSafe(selector, attr) {
        try {
          return await product.findElement(By.css(selector)).getAttribute(attr);
        } catch {
          return 'N/A';
        }
      }

      const name = await getTextSafe('div.name_fav span a');
      const tag = await getTextSafe('div.thumnail_section span');

      let imgUrl = await getAttrSafe('div.thumnail_section img', 'src');
      if (imgUrl !== 'N/A' && imgUrl.includes('image=/https')) {
        imgUrl = imgUrl.replace('image=/https', 'image=https');
      }

      const origin = await getTextSafe('div.country_icon_outer div.text');

      let color = 'N/A';
      try {
        const colorElement = await product.findElement(By.css('span.hlx_plp_color'));
        color = await driver.executeScript(
          'return window.getComputedStyle(arguments[0]).getPropertyValue("background-color")',
          colorElement
        );
      } catch {}

      let length = 'N/A';
      let weight = 'N/A';
      let certificate = 'N/A';
      let diameter = 'N/A';
      let noofbuds = 'N/A';

      try {
        const items = await product.findElements(By.css('.classification_attributes_block li'));
        for (const li of items) {
          try {
            const icon = await li.findElement(By.css('i'));
            const text = sanitize(await li.findElement(By.css('p')).getText());
            const classList = await icon.getAttribute('class');
            if (classList.includes('length_icon')) length = text || 'N/A';
            else if (classList.includes('diameter_icon')) diameter = text || 'N/A';
            else if (classList.includes('weight_icon')) weight = text || 'N/A';
            else if (classList.includes('certificate_icon')) certificate = text || 'N/A';
          } catch {}
        }
      } catch {}

      let farm = 'N/A';
      try {
        const farmElement = await product.findElement(
          By.css('div.classification_attributes_block.labels_attr div.classification_label_attributes')
        );
        farm = await driver.executeScript(`
          const el = arguments[0].cloneNode(true);
          el.querySelectorAll('span').forEach(s => s.remove());
          return (el.textContent || '').trim();
        `, farmElement);
      } catch {}

      let first_quantity = 'N/A';
      let available_quantity = 'N/A';

      try {
        const quantityDivs = await product.findElements(By.css('div.first_quantity'));
        if (quantityDivs.length) {
          let rawQty = sanitize(await quantityDivs[0].getText()).trim();
          rawQty = rawQty.replace(/assortment/i, '').trim();
          available_quantity = rawQty || 'N/A';

          const packDivs = await product.findElements(By.css('div.text-left'));
          if (packDivs.length) {
            const spans = await packDivs[0].findElements(By.css('span'));
            const unitName = spans[0] ? sanitize(await spans[0].getText()) : '';
            const unitCode = spans[1] ? sanitize(await spans[1].getText()) : '';
            first_quantity = `${unitName} (${unitCode}) ${available_quantity}`.trim();
          } else {
            first_quantity = available_quantity;
          }
        }
      } catch {}

      const BASE = 'https://shop.holex.com';
      let productUrl = 'N/A';
      try {
        const rel = await product.findElement(By.css('div.name_fav a')).getAttribute('href');
        if (rel) {
          productUrl = /^https?:\/\//i.test(rel.trim())
            ? rel.trim()
            : BASE.replace(/\/+$/, '') + '/' + rel.trim().replace(/^\/+/, '');
        }
      } catch {}

      function cleanQuantity(text) {
        return text ? text.replace(/^x\s*/, '').trim() : 'N/A';
      }

      const rows = await product.findElements(By.css('div.input_row'));
      const prices = [];

      for (const row of rows) {
        try {
          const className = await row.getAttribute('class');
          const readonlyInputs = await row.findElements(By.css('input[readonly]'));
          if (className.includes('disabled') || readonlyInputs.length) continue;

          let price = 'N/A';
          try {
            const priceEl = await row.findElement(By.css('span.price_text'));
            price = sanitize(
              (await priceEl.getAttribute('from-price')) || (await priceEl.getText())
            ).replace(',', '.');
          } catch {}

          let qty = 'N/A';
          try {
            const quantityEl = await row.findElement(By.css('span.stock_unit.pieces_unit'));
            qty = cleanQuantity(await quantityEl.getText());
          } catch {}

          prices.push({ price, quantity: qty });
        } catch {}
      }

      const stemPrice = prices[0]?.price || 'N/A';
      const quantity = prices[0]?.quantity || 'N/A';
      const secondPrice = prices[1]?.price || 'N/A';
      const second_quantity = prices[1]?.quantity || 'N/A';
      const thirdPrice = prices[2]?.price || 'N/A';
      const third_quantity = prices[2]?.quantity || 'N/A';

      results.push({
        name,
        tag,
        imgUrl,
        origin,
        length,
        diameter,
        noofbuds,
        weight,
        certificate,
        farm,
        color,
        stemPrice,
        quantity,
        first_quantity,
        available_quantity,
        productUrl,
        secondPrice,
        second_quantity,
        thirdPrice,
        third_quantity,
        time,
      });
    } catch (err) {
      log(`❌ Error scraping product: ${err.message}`);
    }
  }

  return results;
}

async function scrapeAllPages(driver) {
  let allProducts = [];
  let pageNum = 1;

  while (true) {
    log(`📄 Scraping page ${pageNum}...`);
    await autoScroll(driver);

    const products = await scrapeProducts(driver);
    allProducts = allProducts.concat(products);

    const nextBtns = await driver.findElements(By.css('li.pagination-next:not(.disabled) a[rel="next"]'));
    if (!nextBtns.length) break;

    const nextUrl = await nextBtns[0].getAttribute('href');
    if (!nextUrl) break;

    const fullUrl = nextUrl.startsWith('http') ? nextUrl : `${ANTHURIUM_BASE_URL}${nextUrl}`;
    log(`➡️ Moving to: ${fullUrl}`);

    await driver.get(fullUrl);
    await sleep(12000);
    pageNum++;
  }

  log(`📭 Finished scraping ${pageNum} pages (${allProducts.length} products).`);
  return allProducts;
}

// ===== MAIN SCRIPT =====
(async () => {
  const startTime = Date.now();

  let driver = null;
  let authClient = null;
  let totalProductsScraped = 0;

  try {
    authClient = await authorize();
    await updateStatus(authClient, 'running', startTime);

    ensureDebugDir();
    driver = await createDriver();

    log('🚀 Script started.');

    const packingDate = await readPackingDate(authClient);

    await login(driver);

    await driver.get(`${ANTHURIUM_BASE_URL}/en_US/All-products/Flowers/c/Flowers`);
    await sleep(3000);
    await saveDebugState(driver, 'flowers-page');
    await closePopup(driver);

    const dateSelected = await selectPackingDate(driver, packingDate);
    if (!dateSelected) {
      log(`⚠️ Packing date ${packingDate} is disabled. Writing "No products found" and exiting.`);
      await writeHeaders(authClient);
      await writeProducts(authClient, [{ name: `No products found {${packingDate}}` }], true);
      await updateStatus(authClient, 'date-disabled', startTime);
      log(`🏁 Script finished. Runtime: ${formatRuntime(Date.now() - startTime)}`);
      return;
    }

    const urls = (process.env.URLS || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    if (!urls.length) {
      log('⚠️ No URLs provided. Exiting.');
      await updateStatus(authClient, 'no-urls', startTime);
      log(`🏁 Script finished. Runtime: ${formatRuntime(Date.now() - startTime)}`);
      return;
    }

    await writeHeaders(authClient);
    let isFirstUrl = true;

    for (const url of urls) {
      log(`➡️ Scraping URL: ${url}`);
      await driver.get(url);
      await sleep(3000);
      await closePopup(driver);

      const products = await scrapeAllPages(driver);
      totalProductsScraped += products.length;

      await writeProducts(authClient, products, isFirstUrl);
      isFirstUrl = false;

      log(`🟢 Finished scraping URL: ${url} (${products.length} products).`);
    }

    log(`🎉 All URLs processed. Total products: ${totalProductsScraped}`);

    if (totalProductsScraped > 0) {
      await updateStatus(authClient, 'success', startTime);
    } else {
      await updateStatus(authClient, 'no-products', startTime);
    }

    log(`🏁 Script finished successfully! Runtime: ${formatRuntime(Date.now() - startTime)}`);
  } catch (err) {
    log(`❌ ERROR: ${err.message}`);

    if (authClient) {
      try {
        await updateStatus(authClient, 'error', startTime, err.message?.substring(0, 80));
      } catch (updateErr) {
        log(`❌ Failed to update error status: ${updateErr.message}`);
      }
    }

    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.quit();
      log('🔒 Browser closed.');
    }
  }
})();
